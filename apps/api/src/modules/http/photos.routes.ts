import { HttpError } from '@maroonedsoftware/errors';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { ICloudError } from '@icloudsync/icloud';
import type { PhotoResource } from '@icloudsync/icloud';
import { z } from 'zod';
import { ICloudService } from '../icloud/icloud.service.js';
import { PhotoArchive } from '../icloud/storage/photo.archive.js';
import { ThumbnailCache } from '../icloud/storage/thumbnail.cache.js';
import { PhotosRepository, type SyncedPhoto } from '../icloud/sync/photos.repository.js';
import { SyncRegistry } from '../icloud/sync/sync.registry.js';
import { SyncProgressRegistry } from '../icloud/sync/sync.progress.registry.js';
import { SYNC_PHOTOS_JOB } from '../icloud/sync/sync.photos.job.js';
import { inFlightJobId } from '../icloud/sync/job.status.js';
import { dispatchSync, enqueueSync } from '../icloud/sync/sync.dispatch.js';
import { SettingsService } from '../settings/settings.service.js';
import { accountIdParam, withICloudErrors } from './route.helpers.js';

/** Whether a rendition key refers to the full-resolution original (what the archive stores). */
function isOriginal(resolution: string): boolean {
    return resolution.startsWith('resOriginal');
}

/** CloudKit `fileType` UTIs → MIME, for rendition formats not implied by the key. */
const UTI_CONTENT_TYPES: Record<string, string> = {
    'public.jpeg': 'image/jpeg',
    'public.png': 'image/png',
    'public.heic': 'image/heic',
    'public.heif': 'image/heif',
    'public.tiff': 'image/tiff',
    'com.compuserve.gif': 'image/gif',
    'public.mpeg-4': 'video/mp4',
    'com.apple.quicktime-movie': 'video/quicktime',
};

/**
 * The inline MIME type for a derived rendition. The rendition key is definitive
 * for the two derivative formats iCloud produces — every `resJPEG*` rendition is
 * JPEG and every `resVid*` rendition is an MP4 clip, regardless of the original's
 * format — so those are mapped by key (which is why a HEIC photo's JPEG thumbnail
 * still serves as `image/jpeg`, and a video preview plays inline as `video/mp4`).
 * Anything else falls back to the resource's CloudKit `fileType` UTI, then a
 * generic binary type.
 */
function renditionContentType(resolution: string, fileType?: string): string {
    if (resolution.startsWith('resJPEG')) return 'image/jpeg';
    if (resolution.startsWith('resVid')) return 'video/mp4';
    return (fileType && UTI_CONTENT_TYPES[fileType]) || 'application/octet-stream';
}

/** Content-server statuses that mean the CloudKit signed URL is stale and a fresh one should be fetched. */
const STALE_URL_STATUSES = new Set([401, 403, 410]);

/** Whether a download error is a stale/expired signed-URL rejection (vs. a genuine upstream failure). */
function isStaleUrlError(error: unknown): boolean {
    return error instanceof ICloudError && error.status !== undefined && STALE_URL_STATUSES.has(error.status);
}

/**
 * Fetch a rendition's bytes through the account's session, healing an expired
 * CloudKit signed URL on the fly. The stored `downloadURL` is tried first; if the
 * content server rejects it as stale (401/403/410), the asset is re-looked-up for
 * fresh URLs, the refreshed renditions are persisted (so later requests skip the
 * round-trip), and the download is retried once with the fresh URL. Throws HTTP
 * 404 when the rendition isn't present, and rethrows the original error when a
 * refresh can't produce a working URL (so it still maps to a 502).
 */
async function downloadRendition(icloud: ICloudService, repo: PhotosRepository, id: string, photo: SyncedPhoto, resolution: string): Promise<Uint8Array> {
    const url = photo.resources[resolution]?.downloadURL;
    if (!url) throw new HttpError(404).withDetails({ reason: 'rendition_not_found', resolution });
    try {
        return await icloud.download(id, url);
    } catch (error) {
        if (!isStaleUrlError(error)) throw error;
        // Expired signed URL — re-look-up the record for fresh URLs and retry once.
        let fresh: Record<string, PhotoResource> | undefined;
        try {
            fresh = await icloud.refreshRenditions(id, photo.recordName, photo.masterRecordName ?? undefined);
        } catch {
            throw error; // refresh itself failed — surface the original stale-URL error
        }
        const freshUrl = fresh?.[resolution]?.downloadURL;
        if (!freshUrl) throw error; // asset gone, or the rendition no longer exists
        await repo.updateResources(id, photo.recordName, fresh!);
        return await icloud.download(id, freshUrl);
    }
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
        // Force a full re-sync: re-download and re-store every asset even when an
        // up-to-date backup is already recorded (e.g. to rebuild a destination).
        force: z.boolean().optional(),
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
 *   schedule, whether a sync is currently running, and `libraryTotal` (the iCloud
 *   library's asset count pulled at the last sync's start, or `null` if none has
 *   run) for the UI's progress denominator.
 * - `GET /icloud/accounts/:accountId/photos` — page the synced library (`limit`,
 *   `offset`, `favorite`, `includeHidden`, `includeDeleted`, `order`).
 * - `GET /icloud/accounts/:accountId/photos/:recordName` — one synced asset's metadata.
 * - `GET /icloud/accounts/:accountId/photos/:recordName/download?resolution=resOriginalRes` —
 *   stream a rendition's bytes through the API. Originals are served as an
 *   attachment, preferring the durable archived copy over a live iCloud fetch;
 *   derived renditions (thumbnails/previews) are served inline and cached on disk
 *   ({@link ThumbnailCache}) so they survive the CloudKit signed URL's expiry.
 * - `POST /icloud/accounts/:accountId/sync` — enqueue an on-demand sync of one
 *   account; body is an optional {@link SyncPhotosPayload} (`force: true` re-backs-up
 *   every asset, ignoring what's already stored). Returns `202 { queued: true, job, jobId }`.
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
        // The library's asset count as pulled at the last sync's start (null until
        // a sync has run); the UI uses it as the progress denominator so it doesn't
        // climb while a first sync pages metadata in.
        const libraryTotal = ctx.container.get(SyncProgressRegistry).libraryTotal(id) ?? null;
        // Whether thumbnails are served at all (disabled when the cache budget is 0),
        // so the UI can hide the recent-backups grid rather than show broken images.
        const thumbnails = ctx.container.get(ThumbnailCache).enabled;
        ctx.body = { id, schedule, running: jobId !== undefined, libraryTotal, thumbnails, ...stats };
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

        // Renditions are immutable (content-addressed by checksum), so let the browser cache them.
        ctx.set('Cache-Control', 'private, max-age=86400');

        // Originals are downloads of the durable backup: serve the archived copy as
        // an attachment when it exists, falling back to a live iCloud fetch.
        if (isOriginal(resolution)) {
            const filename = (photo.filename ?? photo.recordName).replace(/"/g, '');
            ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
            ctx.type = 'application/octet-stream';
            if (photo.backupKey) {
                try {
                    const stream = await ctx.container.get(PhotoArchive).read(photo.backupKey);
                    if (photo.backupSize != null) ctx.set('Content-Length', String(photo.backupSize));
                    ctx.body = stream;
                    return;
                } catch {
                    // Archived copy unreadable (e.g. storage wiped) — fall through to a live fetch.
                }
            }
            ctx.body = Buffer.from(await withICloudErrors(() => downloadRendition(icloud, repo, id, photo, resolution)));
            return;
        }

        // Derived renditions (grid thumbnails, previews) are served inline and cached
        // on disk: the rendition's own iCloud `downloadURL` is a signed URL that
        // expires within hours of a sync, so a read-through cache is what keeps
        // thumbnails from decaying into broken images between syncs. Cache hit streams
        // from disk; a miss fetches from iCloud, caches the bytes, then serves them.
        const cache = ctx.container.get(ThumbnailCache);
        // Thumbnails off (cache budget 0): don't fall back to an uncached live fetch
        // (which would just re-expire) — refuse so the UI hides the grid instead.
        if (!cache.enabled) throw new HttpError(404).withDetails({ reason: 'thumbnails_disabled' });

        const rendition = photo.resources[resolution];
        const cacheKey = cache.key(id, photo.recordName, resolution, rendition?.fileChecksum);
        const contentType = renditionContentType(resolution, rendition?.fileType);

        const cached = await cache.read(cacheKey);
        if (cached) {
            ctx.type = contentType;
            ctx.set('Content-Disposition', 'inline');
            ctx.body = cached;
            return;
        }

        // Miss: fetch through the account (healing an expired signed URL if needed), then cache.
        const bytes = await withICloudErrors(() => downloadRendition(icloud, repo, id, photo, resolution));
        // Best-effort cache write — a storage hiccup must not fail the (successful) fetch.
        try {
            await cache.store(cacheKey, bytes, contentType);
        } catch {
            // Cache unavailable — serve the freshly-fetched bytes anyway.
        }
        ctx.type = contentType;
        ctx.set('Content-Disposition', 'inline');
        ctx.body = Buffer.from(bytes);
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
