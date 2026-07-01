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
import { registerData } from '../../data/data.module.js';
import type { DB } from '../../data/kysely.js';
import { PostgresStorageProvider } from '../../data/postgres.storage.provider.js';
import { SettingsService } from '../../settings/settings.service.js';
import { NotificationsService, registerNotifications } from '../../notifications/index.js';
import { ICloudConfig } from '../icloud.config.js';
import { ICloudService } from '../icloud.service.js';
import { registerICloud } from '../icloud.module.js';
import { PhotoArchive } from '../storage/photo.archive.js';
import { PhotosRepository } from './photos.repository.js';
import { SyncRegistry } from './sync.registry.js';
import { DEFAULT_SYNC_CRON } from './sync.defaults.js';
import { SYNC_PHOTOS_JOB, SyncPhotosJob, type SyncPhotosPayload } from './sync.photos.job.js';
import { SYNC_SWEEP_JOB, SweepPhotosJob } from './sync.dispatch.js';

export { DEFAULT_SYNC_CRON } from './sync.defaults.js';

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
                    container.get(SettingsService),
                    container.get(NotificationsService),
                ),
        )
        .asSingleton();
    registry
        .register(SweepPhotosJob)
        .useFactory(container => new SweepPhotosJob(container.get(ICloudService), container.get(JobBroker), container.get(SyncRegistry)))
        .asSingleton();
}

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
    const pgboss = new PgBoss(connectionString);
    await pgboss.start();
    const registrations = buildPhotoSyncRegistry(cron);
    for (const queue of [SYNC_PHOTOS_JOB, SYNC_SWEEP_JOB]) {
        if (!(await pgboss.getQueue(queue))) await pgboss.createQueue(queue);
    }
    const broker = new PgBossJobBroker(registrations, pgboss, new PgBossConnectionProvider());
    let runner: PgBossJobRunner | undefined;

    return {
        broker,
        startConsumer: async (container: Container) => {
            runner = new PgBossJobRunner(container, registrations, pgboss, logger);
            await runner.start(); // creates queues, schedules the cron, starts workers
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
    /** Storage backend for the encrypted session (defaults to local disk). */
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
    registry.register(Logger).useInstance(new ConsoleLogger());
    const db = registerData(registry, connectionString);
    const settings = new SettingsService(db);
    registry.register(SettingsService).useInstance(settings);
    registry.register(AccountsService).useInstance(new AccountsService(db));
    await registerICloud(registry, config, options.storage ?? new PostgresStorageProvider(db));
    registerPhotoSync(registry);

    const cron = options.cron ?? (await settings.syncCron());

    const pgboss = new PgBoss(connectionString);
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
