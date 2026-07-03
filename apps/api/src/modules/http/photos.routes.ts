import { HttpError } from '@maroonedsoftware/errors';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { z } from 'zod';
import { ICloudService } from '../icloud/icloud.service.js';
import { PhotoArchive } from '../icloud/storage/photo.archive.js';
import { PhotosRepository } from '../icloud/sync/photos.repository.js';
import { SyncRegistry } from '../icloud/sync/sync.registry.js';
import { SYNC_PHOTOS_JOB } from '../icloud/sync/sync.photos.job.js';
import { inFlightJobId } from '../icloud/sync/job.status.js';
import { dispatchSync, enqueueSync } from '../icloud/sync/sync.dispatch.js';
import { SettingsService } from '../settings/settings.service.js';
import { accountIdParam, withICloudErrors } from './route.helpers.js';

/** Whether a rendition key refers to the full-resolution original (what the archive stores). */
function isOriginal(resolution: string): boolean {
    return resolution.startsWith('resOriginal');
}

/** An optional `?flag=true|false` query param (absent → undefined). */
const boolParam = z.preprocess(value => (value === 'true' ? true : value === 'false' ? false : value), z.boolean().optional());

const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    favorite: boolParam,
    includeHidden: boolParam,
    includeDeleted: boolParam,
    order: z.enum(['asc', 'desc']).default('desc'),
});

const downloadQuerySchema = z.object({
    resolution: z.string().min(1).default('resOriginalRes'),
});

const smartAlbumSchema = z.enum([
    'TIMELAPSE',
    'VIDEO',
    'SLOMO',
    'FAVORITE',
    'PANORAMA',
    'SCREENSHOT',
    'BURSTS',
    'LIVE',
    'PORTRAIT',
    'LONG_EXPOSURE',
    'ANIMATED',
]);

const syncSchema = z
    .object({
        direction: z.enum(['ASCENDING', 'DESCENDING']).optional(),
        pageSize: z.coerce.number().int().min(1).max(1000).optional(),
        smartAlbum: smartAlbumSchema.optional(),
        batchSize: z.coerce.number().int().min(1).max(1000).optional(),
        zoneName: z.string().min(1).optional(),
    })
    .default({});

/** The id of the account's tracked sync job if it is still queued or running, else `undefined`. */
function inFlightSyncJob(broker: JobBroker, registry: SyncRegistry, accountId: string): Promise<string | undefined> {
    return inFlightJobId(broker, SYNC_PHOTOS_JOB, registry.jobId(accountId));
}

/**
 * Router for the synced iCloud Photos library, scoped per account by id
 * (`/icloud/accounts/:accountId/…`). Reads are served from the Postgres mirror
 * the sync job populates (fast, paginated, available even when the iCloud
 * session has lapsed); binary downloads proxy back to iCloud using the
 * rendition's signed URL recorded at sync time.
 *
 * - `GET /icloud/accounts/:accountId/stats` — aggregate backup stats, the sync
 *   schedule, and whether a sync is currently running for the account.
 * - `GET /icloud/accounts/:accountId/photos` — page the synced library (`limit`,
 *   `offset`, `favorite`, `includeHidden`, `includeDeleted`, `order`).
 * - `GET /icloud/accounts/:accountId/photos/:recordName` — one synced asset's metadata.
 * - `GET /icloud/accounts/:accountId/photos/:recordName/download?resolution=resOriginalRes` —
 *   stream a rendition's bytes through the API.
 * - `POST /icloud/accounts/:accountId/sync` — enqueue an on-demand sync of one
 *   account; body is an optional {@link SyncPhotosPayload}. Returns `202
 *   { queued: true, job, jobId }`.
 * - `POST /icloud/sync` — fan a sync out across **every** registered account,
 *   one job each (`202 { queued: <count>, job, jobs: [{ id, jobId }] }`).
 * - `POST /icloud/accounts/:accountId/sync/cancel` — request cancellation of the
 *   account's queued-or-running sync via `JobBroker.cancel` (`{ cancelled }` is
 *   whether a live job was found to cancel).
 * - `POST /icloud/sync/cancel` — cancel every tracked in-flight sync
 *   (`{ cancelled }` is the count actually requested).
 */
export function icloudPhotosRouter() {
    const router = ServerKitRouter();
    const json = bodyParserMiddleware(['application/json']);

    router.get('/icloud/accounts/:accountId/stats', async ctx => {
        const repo = ctx.container.get(PhotosRepository);
        const settings = ctx.container.get(SettingsService);
        const id = accountIdParam(ctx);
        const [stats, schedule] = await Promise.all([repo.stats(id), settings.syncCron()]);
        const jobId = await inFlightSyncJob(ctx.container.get(JobBroker), ctx.container.get(SyncRegistry), id);
        ctx.body = { id, schedule, running: jobId !== undefined, ...stats };
    });

    router.get('/icloud/accounts/:accountId/photos', async ctx => {
        const repo = ctx.container.get(PhotosRepository);
        const id = accountIdParam(ctx);
        const { limit, offset, favorite, includeHidden, includeDeleted, order } = await parseAndValidate(ctx.query, listQuerySchema);
        const { photos, total } = await repo.list(id, { limit, offset, favorite, includeHidden, includeDeleted, order });
        ctx.body = { photos, total, limit, offset };
    });

    router.get('/icloud/accounts/:accountId/photos/:recordName', async ctx => {
        const repo = ctx.container.get(PhotosRepository);
        const id = accountIdParam(ctx);
        const photo = await repo.get(id, ctx.params.recordName ?? '');
        if (!photo) throw new HttpError(404).withDetails({ reason: 'photo_not_found' });
        ctx.body = photo;
    });

    router.get('/icloud/accounts/:accountId/photos/:recordName/download', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const repo = ctx.container.get(PhotosRepository);
        const id = accountIdParam(ctx);
        const { resolution } = await parseAndValidate(ctx.query, downloadQuerySchema);

        const photo = await repo.get(id, ctx.params.recordName ?? '');
        if (!photo) throw new HttpError(404).withDetails({ reason: 'photo_not_found' });

        const filename = (photo.filename ?? photo.recordName).replace(/"/g, '');
        ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
        ctx.type = 'application/octet-stream';
        // Renditions are immutable (content-addressed by checksum), so let the browser cache them.
        ctx.set('Cache-Control', 'private, max-age=86400');

        // Prefer the durable archived copy of the original; fall back to a live iCloud fetch.
        if (isOriginal(resolution) && photo.backupKey) {
            try {
                const stream = await ctx.container.get(PhotoArchive).read(photo.backupKey);
                if (photo.backupSize != null) ctx.set('Content-Length', String(photo.backupSize));
                ctx.body = stream;
                return;
            } catch {
                // Archived copy unreadable (e.g. storage wiped) — fall through to a live fetch.
            }
        }

        const url = photo.resources[resolution]?.downloadURL;
        if (!url) throw new HttpError(404).withDetails({ reason: 'rendition_not_found', resolution });
        ctx.body = Buffer.from(await withICloudErrors(() => icloud.download(id, url)));
    });

    router.post('/icloud/accounts/:accountId/sync', json, async ctx => {
        const id = accountIdParam(ctx);
        const options = await parseAndValidate(ctx.body, syncSchema);
        const jobId = await enqueueSync(ctx.container.get(JobBroker), ctx.container.get(SyncRegistry), id, options);
        ctx.status = 202;
        ctx.body = { queued: true, job: SYNC_PHOTOS_JOB, jobId };
    });

    router.post('/icloud/sync', json, async ctx => {
        const options = await parseAndValidate(ctx.body, syncSchema);
        const accounts = await ctx.container.get(ICloudService).listAccounts();
        const jobs = await dispatchSync(
            ctx.container.get(JobBroker),
            ctx.container.get(SyncRegistry),
            accounts.map(a => a.id),
            options,
        );
        ctx.status = 202;
        ctx.body = { queued: jobs.length, job: SYNC_PHOTOS_JOB, jobs };
    });

    router.post('/icloud/accounts/:accountId/sync/cancel', async ctx => {
        const broker = ctx.container.get(JobBroker);
        const id = accountIdParam(ctx);
        // Cancel marks the pg-boss row cancelled; the runner aborts the handler's
        // signal on its next poll (whether the job was still queued or running).
        const jobId = await inFlightSyncJob(broker, ctx.container.get(SyncRegistry), id);
        if (jobId) await broker.cancel(SYNC_PHOTOS_JOB, jobId);
        ctx.body = { cancelled: jobId !== undefined };
    });

    router.post('/icloud/sync/cancel', async ctx => {
        const broker = ctx.container.get(JobBroker);
        const registry = ctx.container.get(SyncRegistry);
        const ids = (await Promise.all(registry.accounts().map(accountId => inFlightSyncJob(broker, registry, accountId)))).filter(
            (id): id is string => id !== undefined,
        );
        if (ids.length) await broker.cancel(SYNC_PHOTOS_JOB, ids);
        ctx.body = { cancelled: ids.length };
    });

    return router;
}
