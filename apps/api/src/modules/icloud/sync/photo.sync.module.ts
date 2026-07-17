import { ConsoleLogger, Logger } from '@maroonedsoftware/logger';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { PgBossConnectionProvider, PgBossJobBroker, PgBossJobRegistryMap, PgBossJobRunner } from '@maroonedsoftware/jobbroker/pgboss';
import type { StorageProvider } from '@maroonedsoftware/storage';
import { createRegistry, type Container, type InjectKitRegistry } from 'injectkit';
import { Kysely } from 'kysely';
import { PgBoss } from 'pg-boss';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { AccountsService } from '../../accounts/accounts.service.js';
import { databaseUrl, loadAppConfig, type AppConfigShape } from '../../config/app.config.js';
import { logDbBackgroundError, registerData } from '../../data/data.module.js';
import type { DB } from '../../data/kysely.js';
import { SettingsService } from '../../settings/settings.service.js';
import { NotificationsService, registerNotifications } from '../../notifications/index.js';
import { ICloudConfig } from '../icloud.config.js';
import { ICloudService } from '../icloud.service.js';
import { registerICloud } from '../icloud.module.js';
import { PhotoArchive } from '../storage/photo.archive.js';
import { PhotosRepository } from './photos.repository.js';
import { SyncRegistry } from './sync.registry.js';
import { SyncProgressRegistry } from './sync.progress.registry.js';
import { DEFAULT_SYNC_CRON } from './sync.defaults.js';
import { SYNC_PHOTOS_JOB, SyncPhotosJob, type SyncPhotosPayload } from './sync.photos.job.js';
import { SYNC_SWEEP_JOB, SweepPhotosJob, reconcileTrackedSyncs, type InFlightSyncJob } from './sync.dispatch.js';
import { RELOCATE_ARCHIVE_JOB, RelocateArchiveJob } from './relocate.archive.job.js';
import { RelocateRegistry } from './relocate.registry.js';

export { DEFAULT_SYNC_CRON } from './sync.defaults.js';

/**
 * pg-boss's server-connection budget, pinned to pg-boss's own default (10) so it
 * is documented rather than implicit. Combined with the Kysely pool's
 * {@link KYSELY_POOL_MAX}, this process opens at most `10 + 10` server
 * connections to Postgres; that sum is what Postgres's `max_connections` (or a
 * fronting pooler's pool size) must accommodate for this app.
 */
export const PGBOSS_POOL_MAX = 10;

/** `application_name` for pg-boss's connections (see {@link KYSELY_APPLICATION_NAME}). */
export const PGBOSS_APPLICATION_NAME = 'icloudsync-pgboss';

/**
 * Construct the pg-boss engine with an explicit, identifiable connection budget:
 * a pinned pool {@link PGBOSS_POOL_MAX max}, an {@link PGBOSS_APPLICATION_NAME
 * application_name} so its connections are distinguishable in `pg_stat_activity`,
 * and a 10s connect timeout so a database blip fails fast and retries (matching
 * the Kysely pool) instead of hanging.
 */
export function createPgBoss(connectionString: string): PgBoss {
    return new PgBoss({ connectionString, max: PGBOSS_POOL_MAX, application_name: PGBOSS_APPLICATION_NAME, connectionTimeoutMillis: 10_000 });
}

/**
 * Subscribe to pg-boss's `error` event so a background failure cannot crash the
 * process.
 *
 * `PgBoss` extends Node's `EventEmitter` and emits `error` for failures that
 * happen off the request path — most commonly its periodic queue-cache refresh
 * ({@link https://github.com/timgit/pg-boss `Manager.onCacheQueues`}) hitting a
 * transient DB error such as `Connection terminated due to connection timeout`.
 * Per the `EventEmitter` contract, an `error` event with **no listener** is
 * re-thrown as `ERR_UNHANDLED_ERROR` and takes down the whole process. These
 * errors are transient (pg-boss retries the cache on its next interval), so the
 * correct handling is to log and swallow rather than tear the engine down.
 * {@link logDbBackgroundError} keeps a database blip from flooding the log at
 * ERROR by logging the transient connectivity cases at WARN.
 */
export function attachPgBossErrorHandler(pgboss: PgBoss, logger: Logger): void {
    pgboss.on('error', error => logDbBackgroundError(logger, 'pg-boss', error));
}

/**
 * Register the photo-sync graph ({@link PhotosRepository} + {@link SyncPhotosJob})
 * into a registry. Expects `Kysely`, {@link ICloudService}, {@link SettingsService},
 * and {@link Logger} to already be registered (see {@link startPhotoSyncWorker}).
 * Also registers {@link NotificationsService} so the job can alert the admin when
 * an account needs re-authentication.
 */
export function registerPhotoSync(registry: InjectKitRegistry): void {
    registry
        .register(PhotosRepository)
        .useFactory(container => new PhotosRepository(container.get(Kysely) as Kysely<DB>))
        .asSingleton();
    registry
        .register(SyncRegistry)
        .useFactory(() => new SyncRegistry())
        .asSingleton();
    registry
        .register(SyncProgressRegistry)
        .useFactory(() => new SyncProgressRegistry())
        .asSingleton();
    registry
        .register(RelocateRegistry)
        .useFactory(() => new RelocateRegistry())
        .asSingleton();
    registerNotifications(registry);
    registry
        .register(SyncPhotosJob)
        .useFactory(
            container =>
                new SyncPhotosJob(
                    container.get(ICloudService),
                    container.get(PhotosRepository),
                    container.get(PhotoArchive),
                    container.get(Logger),
                    container.get(NotificationsService),
                    container.get(AccountsService),
                    container.get(SyncProgressRegistry),
                ),
        )
        .asSingleton();
    registry
        .register(SweepPhotosJob)
        .useFactory(container => new SweepPhotosJob(container.get(ICloudService), container.get(JobBroker), container.get(SyncRegistry)))
        .asSingleton();
    registry
        .register(RelocateArchiveJob)
        .useFactory(
            container =>
                new RelocateArchiveJob(container.get(PhotoArchive), container.get(PhotosRepository), container.get(AccountsService), container.get(Logger)),
        )
        .asSingleton();
}

/**
 * Durability policy for the per-account {@link SYNC_PHOTOS_JOB} queue, tuned so a
 * sync survives (and promptly resumes after) a process restart.
 *
 * pg-boss can end an `active` job two ways (both re-queue it as a retry while
 * retries remain, else dead-letter it):
 * - `expireInSeconds` — an **absolute** cap on how long a job may run, counted
 *   from when it started. It also bounds the in-process handler, so a healthy but
 *   slow sync (a large library, or one waiting out iCloud rate limits) is aborted
 *   mid-run once it elapses. pg-boss defaults this to 15 minutes, which is easily
 *   exceeded; we raise it so a normal sync runs to completion in one pass.
 * - `heartbeatSeconds` — an **earlier** failure path that fires only when the
 *   worker stops sending heartbeats (pg-boss touches the row automatically while
 *   the handler runs). A live sync keeps heartbeating, so this never trips it; but
 *   when the process is killed mid-sync, the job is reclaimed within roughly this
 *   interval instead of waiting out the full `expireInSeconds`. That is what makes
 *   a sync resume promptly after a restart rather than sitting idle for minutes.
 *
 * `retryLimit` is raised well above pg-boss's default of 2 because each restart
 * (or expiry) consumes one retry: a couple of restarts during a long sync must
 * not exhaust the budget and strand the job in the dead-letter state.
 */
export const SYNC_QUEUE_POLICY = {
    /** 2h absolute cap — long enough for a full library pass, short enough to reclaim a truly hung worker. */
    expireInSeconds: 2 * 60 * 60,
    /** Reclaim a killed worker's job within ~a minute (must be >= 10). */
    heartbeatSeconds: 60,
    /** Tolerate many restart/expiry cycles before dead-lettering (default is 2). */
    retryLimit: 10,
} as const;

/**
 * Build the pg-boss registry map: the per-account {@link SyncPhotosJob} is
 * on-demand (enqueued by the API and by the sweep), while the
 * {@link SweepPhotosJob} runs on the cron schedule and fans out one per-account
 * job per registered account.
 */
export function buildPhotoSyncRegistry(cron: string = DEFAULT_SYNC_CRON): PgBossJobRegistryMap {
    const registrations = new PgBossJobRegistryMap();
    registrations.set(SYNC_PHOTOS_JOB, SyncPhotosJob);
    registrations.set(SYNC_SWEEP_JOB, { job: SweepPhotosJob, cron });
    registrations.set(RELOCATE_ARCHIVE_JOB, RelocateArchiveJob);
    return registrations;
}

/**
 * A pg-boss engine that both enqueues the photo-sync job (producer, via
 * {@link broker}) and — once {@link startConsumer} is called — processes it on a
 * cron schedule (consumer). Both sides share one pg-boss connection, which is
 * what lets the HTTP API run the worker in-process (single-container model).
 */
export interface SyncEngine {
    /** Producer the API binds to {@link JobBroker} for `POST /icloud/sync`. */
    broker: PgBossJobBroker;
    /** Start consuming the queue (registers workers + cron). Call after the DI container is built. */
    startConsumer(container: Container): Promise<void>;
    /**
     * Re-track any sync that was still queued or running when this process last
     * stopped. pg-boss holds (and resumes) those jobs, but the in-memory
     * {@link SyncRegistry} the API reads is wiped by a restart; this repopulates
     * it from the durable queue so `/stats` reports the running sync and cancel
     * can still reach it. Best-effort — call after a restart. Returns the number
     * of accounts re-tracked.
     */
    reconcileInFlight(registry: SyncRegistry): Promise<number>;
    /** Stop the consumer (if started) and the pg-boss connection. */
    stop(): Promise<void>;
}

/**
 * Start a shared pg-boss engine for the combined API+worker process. The
 * producer ({@link SyncEngine.broker}) is available immediately so it can be
 * registered before the DI container is built; the consumer is attached
 * afterwards with {@link SyncEngine.startConsumer} (the runner needs the built
 * container to resolve the job). For a producer-only deployment (separate
 * worker), skip `startConsumer` and run {@link startPhotoSyncWorker} elsewhere.
 */
export async function startSyncEngine(connectionString: string, logger: Logger, cron: string = DEFAULT_SYNC_CRON): Promise<SyncEngine> {
    const pgboss = createPgBoss(connectionString);
    attachPgBossErrorHandler(pgboss, logger);
    await pgboss.start();
    const registrations = buildPhotoSyncRegistry(cron);
    for (const queue of [SYNC_PHOTOS_JOB, SYNC_SWEEP_JOB, RELOCATE_ARCHIVE_JOB]) {
        if (!(await pgboss.getQueue(queue))) await pgboss.createQueue(queue);
    }
    // Apply the sync queue's durability policy on every boot (not just at creation),
    // so deployments whose queue predates this policy pick it up too. updateQueue is
    // idempotent; a live sync keeps running while its queue's settings are updated.
    await pgboss.updateQueue(SYNC_PHOTOS_JOB, { ...SYNC_QUEUE_POLICY });
    const broker = new PgBossJobBroker(registrations, pgboss, new PgBossConnectionProvider());
    let runner: PgBossJobRunner | undefined;

    return {
        broker,
        startConsumer: async (container: Container) => {
            runner = new PgBossJobRunner(container, registrations, pgboss, logger);
            await runner.start(); // creates queues, schedules the cron, starts workers
        },
        reconcileInFlight: async (registry: SyncRegistry) => {
            // findJobs returns every retained job on the queue (including terminal
            // ones); reconcileTrackedSyncs keeps only the in-flight ones per account.
            const jobs = (await pgboss.findJobs(SYNC_PHOTOS_JOB)) as InFlightSyncJob[];
            return reconcileTrackedSyncs(registry, jobs);
        },
        stop: () => (runner ? runner.stop() : pgboss.stop()), // runner.stop() also stops pg-boss
    };
}

export interface PhotoSyncWorkerOptions {
    /** Pre-loaded app config. Defaults to {@link loadAppConfig} (reads `config/app.yaml` + env). */
    appConfig?: AppConfig<AppConfigShape>;
    /** Override the schedule; defaults to the `sync_cron` setting in the database. */
    cron?: string;
    connectionString?: string;
    config?: ICloudConfig;
    /** Storage backend for the archived photo bytes (defaults to local disk under `config.photosDir`). */
    storage?: StorageProvider;
}

export interface PhotoSyncWorker {
    container: Container;
    broker: PgBossJobBroker;
    runner: PgBossJobRunner;
    /** Enqueue a one-off sync immediately (outside the cron schedule). */
    triggerNow(payload?: SyncPhotosPayload): Promise<void>;
    /** Gracefully stop the runner, pg-boss, and the database pool. */
    stop(): Promise<void>;
}

/**
 * Bootstrap the photo-sync background worker end-to-end: wire the DI graph
 * (config, data, iCloud, sync), start pg-boss, register the scheduled job, and
 * begin processing. The job runs on `cron` (default every 6 hours) and can also
 * be triggered on demand via {@link PhotoSyncWorker.triggerNow}.
 *
 * ```ts
 * const worker = await startPhotoSyncWorker();
 * await worker.triggerNow();             // kick off an immediate sync
 * process.on('SIGTERM', () => worker.stop());
 * ```
 */
export async function startPhotoSyncWorker(options: PhotoSyncWorkerOptions = {}): Promise<PhotoSyncWorker> {
    const appConfig = options.appConfig ?? (await loadAppConfig());
    const connectionString = options.connectionString ?? databaseUrl(appConfig);
    const config = options.config ?? ICloudConfig.fromAppConfig(appConfig);

    const registry = createRegistry();
    const logger = new ConsoleLogger();
    registry.register(Logger).useInstance(logger);
    const db = registerData(registry, connectionString, logger);
    const settings = new SettingsService(db);
    registry.register(SettingsService).useInstance(settings);
    registry.register(AccountsService).useInstance(new AccountsService(db));
    await registerICloud(registry, config, db, options.storage);
    registerPhotoSync(registry);

    const cron = options.cron ?? (await settings.syncCron());

    const pgboss = createPgBoss(connectionString);
    attachPgBossErrorHandler(pgboss, logger);
    await pgboss.start();

    // The broker must be registered before the container is built: SweepPhotosJob
    // resolves JobBroker to fan the scheduled sweep out into per-account jobs.
    const registrations = buildPhotoSyncRegistry(cron);
    const broker = new PgBossJobBroker(registrations, pgboss, new PgBossConnectionProvider());
    registry.register(JobBroker).useInstance(broker);
    const container = registry.build();

    const runner = new PgBossJobRunner(container, registrations, pgboss, container.get(Logger));
    await runner.start();

    return {
        container,
        broker,
        runner,
        // Kick off an immediate sweep, which fans out one job per registered account.
        triggerNow: async (payload: SyncPhotosPayload = {}) => {
            await broker.send(SYNC_SWEEP_JOB, payload);
        },
        stop: async () => {
            await runner.stop(); // also stops pg-boss
            await db.destroy();
        },
    };
}
