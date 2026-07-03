import { ServerKitRouter } from '@maroonedsoftware/koa';
import { ICloudService } from '../icloud/icloud.service.js';
import { PhotosRepository } from '../icloud/sync/photos.repository.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * Administration router: a single aggregate view across **all** accounts for the
 * management UI, so it doesn't have to fan out one request per account.
 *
 * - `GET /icloud/overview` → `{ schedule, accounts: [{ account, authenticated,
 *   ...backup stats }] }` — the global sync schedule plus each registered
 *   account's live auth state and synced-library stats.
 *
 * Per-account actions (sync, logout, remove) and the all-account
 * `POST /icloud/sync` live on the auth/photos routers; this router is read-only.
 */
export function icloudAdminRouter() {
    const router = ServerKitRouter();

    router.get('/icloud/overview', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const repo = ctx.container.get(PhotosRepository);
        const settings = ctx.container.get(SettingsService);

        const [statuses, schedule] = await Promise.all([icloud.accountsStatus(), settings.syncCron()]);
        const accounts = await Promise.all(statuses.map(async status => ({ ...status, ...(await repo.stats(status.id)) })));
        ctx.body = { schedule, accounts };
    });

    return router;
}
