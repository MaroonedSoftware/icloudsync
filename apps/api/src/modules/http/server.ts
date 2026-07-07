import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { errorMiddleware, serverKitContextMiddleware } from '@maroonedsoftware/koa';
import type { ServerKitContext } from '@maroonedsoftware/koa';
import { ConsoleLogger, Logger } from '@maroonedsoftware/logger';
import type { StorageProvider } from '@maroonedsoftware/storage';
import { createRegistry, type Container } from 'injectkit';
import Koa, { type DefaultState } from 'koa';
import { databaseUrl, loadAppConfig, webRoot, type AppConfigShape } from '../config/app.config.js';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { AccountsService } from '../accounts/accounts.service.js';
import { registerData } from '../data/data.module.js';
import { ICloudConfig } from '../icloud/icloud.config.js';
import { ICloudService } from '../icloud/icloud.service.js';
import { registerICloud } from '../icloud/icloud.module.js';
import { registerPhotoSync, startSyncEngine, type SyncEngine } from '../icloud/sync/photo.sync.module.js';
import { SyncRegistry } from '../icloud/sync/sync.registry.js';
import { SettingsService } from '../settings/settings.service.js';
import { registerBodyParser } from './body.parser.js';
import { HttpConfig } from './http.config.js';
import { healthRouter } from './health.routes.js';
import { icloudAdminRouter } from './admin.routes.js';
import { icloudAuthRouter } from './icloud.routes.js';
import { icloudPhotosRouter } from './photos.routes.js';
import { icloudSettingsRouter } from './settings.routes.js';
import { staticSpa } from './static.spa.js';

/** Optional extras for {@link createApiApp}. */
export interface CreateApiAppOptions {
    /** Directory of a built SPA to serve on unmatched GETs (history-API fallback). Omit for API-only. */
    webRoot?: string;
}

/**
 * Assemble the Koa application over a built {@link Container}. The middleware
 * order matters: {@link errorMiddleware} wraps the stack so thrown
 * {@link HttpError}s become responses, then {@link serverKitContextMiddleware}
 * attaches the request-scoped container/logger that routes and the body parser
 * depend on. The optional static SPA is mounted **last**, so only requests that
 * no API route matched fall through to it. Errors and unmatched-route warnings
 * the middleware emits on the app are forwarded to the {@link Logger}.
 */
export function createApiApp(container: Container, options: CreateApiAppOptions = {}): Koa<DefaultState, ServerKitContext> {
    const app = new Koa<DefaultState, ServerKitContext>();
    const logger = container.get(Logger);

    app.use(errorMiddleware());
    app.use(serverKitContextMiddleware(container));

    for (const router of [healthRouter(), icloudAdminRouter(), icloudAuthRouter(), icloudPhotosRouter(), icloudSettingsRouter()]) {
        app.use(router.routes());
        app.use(router.allowedMethods());
    }

    if (options.webRoot) app.use(staticSpa(options.webRoot, { passthroughPrefixes: ['/icloud'] }));

    // Koa emits 'error' for every thrown error, including the HttpErrors the
    // middleware turns into responses. A 4xx is an expected client outcome (e.g. a
    // 404 for a photo that isn't synced yet), not a server fault, so log those at
    // debug and reserve error level for genuine 5xx / uncaught failures.
    app.on('error', (error: unknown) => {
        const status = (error as { statusCode?: unknown } | null)?.statusCode;
        if (typeof status === 'number' && status >= 400 && status < 500) {
            logger.debug('http client error', error);
        } else {
            logger.error('http request failed', error);
        }
    });
    app.on('warn', (warning: unknown) => logger.warn('http request warning', warning));

    return app;
}

export interface ApiServerOptions {
    /** Pre-loaded app config. Defaults to {@link loadAppConfig} (reads `config/app.yaml` + env). */
    appConfig?: AppConfig<AppConfigShape>;
    /** Listen port. Defaults to the `http` config section (env `PORT`, else 3000). `0` picks a free port. */
    port?: number;
    config?: ICloudConfig;
    /** Storage backend for the archived photo bytes (defaults to local disk under `config.photosDir`). */
    storage?: StorageProvider;
    /** Postgres connection string. Defaults to the `database` config section (env `DATABASE_URL`). */
    connectionString?: string;
    /** Built SPA directory to serve. Defaults to the `web` config section (env `WEB_ROOT`); omit for API only. */
    webRoot?: string;
    /** Override the sync schedule; defaults to the `sync_cron` setting in the database. */
    cron?: string;
}

export interface ApiServer {
    app: Koa<DefaultState, ServerKitContext>;
    server: Server;
    container: Container;
    /** The port actually bound (resolved when `port: 0` was requested). */
    port: number;
    /** Stop accepting connections, the in-process sync worker, and the database pool. */
    stop(): Promise<void>;
}

/**
 * Bootstrap the whole application as a single process: the DI graph (logger,
 * JSON body parser, iCloud module, Postgres data layer, photo-sync graph), an
 * in-process pg-boss engine that both serves `POST /icloud/sync` (producer) and
 * runs the scheduled sync (consumer + cron), the HTTP API, and — when a built
 * SPA is configured — the web UI on the same port. This single-container model
 * means one process owns the API, the worker, and the UI.
 *
 * ```ts
 * const api = await startApiServer();
 * process.on('SIGTERM', () => api.stop());
 * ```
 */
export async function startApiServer(options: ApiServerOptions = {}): Promise<ApiServer> {
    const appConfig = options.appConfig ?? (await loadAppConfig());
    const config = options.config ?? ICloudConfig.fromAppConfig(appConfig);
    const port = options.port ?? HttpConfig.fromAppConfig(appConfig).port;
    const connectionString = options.connectionString ?? databaseUrl(appConfig);
    const ui = options.webRoot ?? webRoot(appConfig);

    const logger = new ConsoleLogger();
    const registry = createRegistry();
    registry.register(Logger).useInstance(logger);
    registerBodyParser(registry);
    const db = registerData(registry, connectionString);
    const settings = new SettingsService(db);
    registry.register(SettingsService).useInstance(settings);
    registry.register(AccountsService).useInstance(new AccountsService(db));
    // The encrypted session lives on each account's row and the salt in app_settings
    // (no session volume needed); `storage`, when given, backs the photo archive.
    await registerICloud(registry, config, db, options.storage);
    registerPhotoSync(registry); // PhotosRepository + SyncPhotosJob

    // Schedule comes from the DB settings (overridable for tests).
    const cron = options.cron ?? (await settings.syncCron());

    // Producer is needed before the container is built (routes resolve JobBroker);
    // the consumer (runner) is attached after, since it resolves the job from the container.
    const sync: SyncEngine = await startSyncEngine(connectionString, logger, cron);
    registry.register(JobBroker).useInstance(sync.broker);

    const container = registry.build();
    await sync.startConsumer(container);

    // pg-boss still holds (and resumes) any sync that was mid-flight when this
    // process last stopped, but the in-memory SyncRegistry the API reads to report
    // and cancel a run was wiped by the restart. Re-track those jobs so /stats
    // shows the running sync and cancel can still reach it.
    try {
        const reattached = await sync.reconcileInFlight(container.get(SyncRegistry));
        if (reattached > 0) logger.info(`re-attached to ${reattached} in-flight sync${reattached === 1 ? '' : 's'} after restart`);
    } catch (error) {
        logger.warn('reconciling in-flight syncs on boot failed', error);
    }

    // Load every registered account's session up front so /icloud/accounts
    // reflects auth state immediately after a restart (not only after a sync).
    try {
        await container.get(ICloudService).restore();
    } catch (error) {
        logger.warn('icloud session restore on boot failed', error);
    }

    const app = createApiApp(container, { webRoot: ui });
    const server = await new Promise<Server>(resolve => {
        const listener = app.listen(port, () => resolve(listener));
    });

    return {
        app,
        server,
        container,
        port: (server.address() as AddressInfo).port,
        stop: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close(error => (error ? reject(error) : resolve()));
            });
            await sync.stop();
            await db.destroy();
        },
    };
}
