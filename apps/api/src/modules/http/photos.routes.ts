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
import { dispatchSync, enqueueSync } from '../icloud/sync/sync.dispatch.js';
import { SettingsService } from '../settings/settings.service.js';
import { accountParam, withICloudErrors } from './route.helpers.js';

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

/** pg-boss states that mean a sync job is still queued or executing. */
const IN_FLIGHT_STATES = new Set(['created', 'active', 'retry']);

/**
 * The id of the account's tracked sync job if it is still queued or running,
 * else `undefined`. Consulting the broker (rather than trusting the registry
 * alone) means a stale entry for a job that has since finished correctly reads
 * as "not running".
 */
async function inFlightSyncJob(broker: JobBroker, registry: SyncRegistry, account: string): Promise<string | undefined> {
    const id = registry.jobId(account);
    if (!id) return undefined;
    const info = await broker.getJob(SYNC_PHOTOS_JOB, id);
    return info && IN_FLIGHT_STATES.has(info.state) ? id : undefined;
}

/**
 * Router for the synced iCloud Photos library, scoped per account
 * (`/icloud/accounts/:account/…`). Reads are served from the Postgres mirror the
 * sync job populates (fast, paginated, available even when the iCloud session
 * has lapsed); binary downloads proxy back to iCloud using the rendition's
 * signed URL recorded at sync time.
 *
 * - `GET /icloud/accounts/:account/stats` — aggregate backup stats, the sync
 *   schedule, and whether a sync is currently running for the account.
 * - `GET /icloud/accounts/:account/photos` — page the synced library (`limit`,
 *   `offset`, `favorite`, `includeHidden`, `includeDeleted`, `order`).
 * - `GET /icloud/accounts/:account/photos/:recordName` — one synced asset's metadata.
 * - `GET /icloud/accounts/:account/photos/:recordName/download?resolution=resOriginalRes` —
 *   stream a rendition's bytes through the API.
 * - `POST /icloud/accounts/:account/sync` — enqueue an on-demand sync of one
 *   account; body is an optional {@link SyncPhotosPayload}. Returns `202
 *   { queued: true, job, jobId }`.
 * - `POST /icloud/sync` — fan a sync out across **every** registered account,
 *   one job each (`202 { queued: <count>, job, jobs: [{ account, jobId }] }`).
 * - `POST /icloud/accounts/:account/sync/cancel` — request cancellation of the
 *   account's queued-or-running sync via `JobBroker.cancel` (`{ cancelled }` is
 *   whether a live job was found to cancel).
 * - `POST /icloud/sync/cancel` — cancel every tracked in-flight sync
 *   (`{ cancelled }` is the count actually requested).
 */
export function icloudPhotosRouter() {
    const router = ServerKitRouter();
    const json = bodyParserMiddleware(['application/json']);

    router.get('/icloud/accounts/:account/stats', async ctx => {
        const repo = ctx.container.get(PhotosRepository);
        const settings = ctx.container.get(SettingsService);
        const account = accountParam(ctx);
        const [stats, schedule] = await Promise.all([repo.stats(account), settings.syncCron()]);
        const jobId = await inFlightSyncJob(ctx.container.get(JobBroker), ctx.container.get(SyncRegistry), account);
        ctx.body = { account, schedule, running: jobId !== undefined, ...stats };
    });

    router.get('/icloud/accounts/:account/photos', async ctx => {
        const repo = ctx.container.get(PhotosRepository);
        const account = accountParam(ctx);
        const { limit, offset, favorite, includeHidden, includeDeleted, order } = await parseAndValidate(ctx.query, listQuerySchema);
        const { photos, total } = await repo.list(account, { limit, offset, favorite, includeHidden, includeDeleted, order });
        ctx.body = { photos, total, limit, offset };
    });

    router.get('/icloud/accounts/:account/photos/:recordName', async ctx => {
        const repo = ctx.container.get(PhotosRepository);
        const account = accountParam(ctx);
        const photo = await repo.get(account, ctx.params.recordName ?? '');
        if (!photo) throw new HttpError(404).withDetails({ reason: 'photo_not_found' });
        ctx.body = photo;
    });

    router.get('/icloud/accounts/:account/photos/:recordName/download', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const repo = ctx.container.get(PhotosRepository);
        const account = accountParam(ctx);
        const { resolution } = await parseAndValidate(ctx.query, downloadQuerySchema);

        const photo = await repo.get(account, ctx.params.recordName ?? '');
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
        ctx.body = Buffer.from(await withICloudErrors(() => icloud.download(account, url)));
    });

    router.post('/icloud/accounts/:account/sync', json, async ctx => {
        const account = accountParam(ctx);
        const options = await parseAndValidate(ctx.body, syncSchema);
        const jobId = await enqueueSync(ctx.container.get(JobBroker), ctx.container.get(SyncRegistry), account, options);
        ctx.status = 202;
        ctx.body = { queued: true, job: SYNC_PHOTOS_JOB, jobId };
    });

    router.post('/icloud/sync', json, async ctx => {
        const options = await parseAndValidate(ctx.body, syncSchema);
        const accounts = await ctx.container.get(ICloudService).listAccounts();
        const jobs = await dispatchSync(ctx.container.get(JobBroker), ctx.container.get(SyncRegistry), accounts, options);
        ctx.status = 202;
        ctx.body = { queued: jobs.length, job: SYNC_PHOTOS_JOB, jobs };
    });

    router.post('/icloud/accounts/:account/sync/cancel', async ctx => {
        const broker = ctx.container.get(JobBroker);
        const account = accountParam(ctx);
        // Cancel marks the pg-boss row cancelled; the runner aborts the handler's
        // signal on its next poll (whether the job was still queued or running).
        const jobId = await inFlightSyncJob(broker, ctx.container.get(SyncRegistry), account);
        if (jobId) await broker.cancel(SYNC_PHOTOS_JOB, jobId);
        ctx.body = { cancelled: jobId !== undefined };
    });

    router.post('/icloud/sync/cancel', async ctx => {
        const broker = ctx.container.get(JobBroker);
        const registry = ctx.container.get(SyncRegistry);
        const ids = (await Promise.all(registry.accounts().map(account => inFlightSyncJob(broker, registry, account)))).filter(
            (id): id is string => id !== undefined,
        );
        if (ids.length) await broker.cancel(SYNC_PHOTOS_JOB, ids);
        ctx.body = { cancelled: ids.length };
    });

    return router;
}
