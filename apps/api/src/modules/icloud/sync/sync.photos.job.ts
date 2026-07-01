import { Job } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import type { ListOptions, PhotoAsset, PhotoResource, PhotosService, SmartAlbum, SortDirection } from '@icloudsync/icloud';
import { SettingsService } from '../../settings/settings.service.js';
import { PhotoArchive } from '../storage/photo.archive.js';
import { layoutGroup, type PhotoLayout } from '../storage/photo.layout.js';
import type { PhotoStore } from './photos.repository.js';

/** The pg-boss queue name for the photo-sync job. pg-boss only allows
 * alphanumerics, `_`, `-`, `.`, `/` in names — no colons. */
export const SYNC_PHOTOS_JOB = 'icloud/sync-photos';

/** Rendition keys that hold the full-resolution original (photo, then video). */
const ORIGINAL_KEYS = ['resOriginalRes', 'resOriginalVidComplRes'];

/** Pick the asset's original rendition (the thing worth archiving), or undefined. */
function pickOriginal(asset: PhotoAsset): PhotoResource | undefined {
    for (const key of ORIGINAL_KEYS) {
        const resource = asset.resources[key];
        if (resource?.downloadURL) return resource;
    }
    return Object.values(asset.resources).find(r => r.key.startsWith('resOriginal') && r.downloadURL);
}

/** Payload accepted by {@link SyncPhotosJob}. All fields optional. */
export interface SyncPhotosPayload {
    /** Sort order to page in (default ASCENDING). */
    direction?: SortDirection;
    /** Assets per CloudKit page (default 100). */
    pageSize?: number;
    /** Restrict the sync to a smart album (e.g. `FAVORITE`). */
    smartAlbum?: SmartAlbum;
    /** Rows per upsert batch (default 200). */
    batchSize?: number;
    /** CloudKit zone to sync (default `PrimarySync`). */
    zoneName?: string;
    /** Skip downloading photo bytes — mirror metadata only (default false). */
    metadataOnly?: boolean;
    /** Override the on-disk organization for this run (defaults to the configured layout). */
    layout?: PhotoLayout;
    /** The account to sync. Always set by the producer ({@link enqueueSync}); a run without it is a no-op. */
    accountName?: string;
}

/**
 * The reauth-notification surface the job needs. {@link NotificationsService}
 * satisfies it structurally; kept minimal so the job can be tested with a fake.
 */
export interface ReauthReporter {
    /** Alert the admin that an account's session expired and it needs re-login. */
    notifyReauthRequired(account: string): Promise<void>;
    /** Note that an account is authenticated again (resets its alert throttle). */
    clearReauth(account: string): Promise<void>;
}

/**
 * The minimal iCloud surface the job needs. {@link ICloudService} satisfies it
 * structurally, so the job can be unit-tested with a lightweight fake.
 */
export interface PhotoSyncSource {
    /** Every registered account to consider syncing. */
    listAccounts(): Promise<string[]>;
    /** Restore an account's persisted session; returns whether it is authenticated. */
    restoreAccount(accountName: string): Promise<boolean>;
    /** Whether the account currently has an authenticated session loaded. */
    isAuthenticated(accountName: string): boolean;
    /** The Photos service for an account, scoped to a CloudKit zone (default `PrimarySync`). */
    photos(accountName: string, zoneName?: string): PhotosService;
    /** Download bytes from a signed iCloud rendition URL using the account's session. */
    download(accountName: string, url: string): Promise<Uint8Array>;
}

/**
 * Background job that backs up **one** iCloud Photos library: it pages the
 * library, upserts every asset's metadata into Postgres in batches, then
 * downloads the original bytes and archives them via {@link PhotoArchive}. Both
 * steps are idempotent — metadata upserts key on `(account, record)`, and an
 * asset's bytes are re-fetched only when its checksum changes — so a re-run
 * resumes rather than redoing work.
 *
 * The account to sync is named in `payload.accountName`; the producer
 * ({@link enqueueSync}) always sets it, and the scheduled sweep fans out one
 * job per account (see {@link SweepPhotosJob}). The account's session is
 * restored first; if it isn't authenticated (e.g. the trust token expired), the
 * run is skipped with a log rather than failing the queue.
 *
 * Cancellation is cooperative: the runner passes an {@link AbortSignal} that is
 * aborted when the job is cancelled (`JobBroker.cancel`) or the runner shuts
 * down. It is polled between pages and per-asset downloads (the two slow
 * points), so a cancel stops the run promptly and cleanly rather than mid-write:
 * batches already flushed stay committed, and a resumed run picks up where this
 * one left off.
 */
export class SyncPhotosJob extends Job<SyncPhotosPayload> {
    constructor(
        private readonly icloud: PhotoSyncSource,
        private readonly store: PhotoStore,
        private readonly archive: PhotoArchive,
        private readonly logger: Logger,
        private readonly settings: SettingsService,
        /** Alerts the admin when an account needs re-authentication. Optional (notifications may be off). */
        private readonly notifications?: ReauthReporter,
    ) {
        super();
    }

    async run(payload: SyncPhotosPayload = {}, signal?: AbortSignal): Promise<void> {
        const account = payload.accountName;
        if (!account) {
            this.logger.warn(`[${SYNC_PHOTOS_JOB}] no account in payload; nothing to sync`);
            return;
        }
        await this.backupAccount(account, payload, signal);
    }

    /**
     * The account backup itself, run under an optional cancellation
     * {@link AbortSignal} (absent only in tests that don't exercise cancel). The
     * signal is polled between pages and between per-asset downloads, so a cancel
     * request stops the run promptly and cleanly: batches already flushed stay
     * committed, and a resumed run picks up where this one left off (metadata
     * upserts and byte archival are both idempotent).
     */
    private async backupAccount(account: string, payload: SyncPhotosPayload, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            this.logger.info(`[${SYNC_PHOTOS_JOB}] sync of ${account} cancelled before it started`);
            return;
        }

        const authenticated = await this.icloud.restoreAccount(account);
        if (!authenticated) {
            this.logger.warn(`[${SYNC_PHOTOS_JOB}] account ${account} is not authenticated; skipping`);
            await this.notifications?.notifyReauthRequired(account);
            return;
        }
        // Authenticated: reset any reauth-alert throttle so a future break notifies promptly.
        await this.notifications?.clearReauth(account);

        const batchSize = payload.batchSize ?? 200;
        const backupBytes = !payload.metadataOnly;
        const listOptions: ListOptions = {};
        if (payload.direction) listOptions.direction = payload.direction;
        if (payload.pageSize) listOptions.pageSize = payload.pageSize;
        if (payload.smartAlbum) listOptions.smartAlbum = payload.smartAlbum;

        // Skip set so re-runs don't re-download unchanged originals.
        const backedUp = backupBytes ? await this.store.backedUpChecksums(account) : new Map<string, string | null>();
        const photos = this.icloud.photos(account, payload.zoneName);
        const layout = payload.layout ?? (await this.settings.photosLayout());
        // For album layout, resolve which album each asset belongs to up front.
        const albums = backupBytes && layout === 'album' ? await this.buildAlbumMap(photos) : new Map<string, string>();
        const albumOf = (recordName: string): string | undefined => albums.get(recordName);

        let batch: PhotoAsset[] = [];
        let total = 0;
        let archived = 0;

        const flush = async (): Promise<void> => {
            if (batch.length === 0) return;
            total += await this.store.upsertBatch(account, batch);
            if (backupBytes) {
                for (const asset of batch) {
                    if (signal?.aborted) break; // stop downloading mid-batch when cancelled
                    if (await this.backup(account, asset, backedUp, layout, albumOf)) archived += 1;
                }
            }
            this.logger.info(`[${SYNC_PHOTOS_JOB}] ${total} synced, ${archived} archived for ${account}`);
            batch = [];
        };

        for await (const asset of photos.list(listOptions)) {
            if (signal?.aborted) break; // stop paging when cancelled
            batch.push(asset);
            if (batch.length >= batchSize) await flush();
        }
        if (signal?.aborted) {
            this.logger.info(`[${SYNC_PHOTOS_JOB}] sync of ${account} cancelled: ${total} synced, ${archived} archived so far`);
            return;
        }
        await flush();

        this.logger.info(`[${SYNC_PHOTOS_JOB}] sync complete: ${total} synced, ${archived} archived for ${account}`);
    }

    /** Download and archive an asset's original bytes unless an up-to-date copy exists. Returns whether it stored anything. */
    private async backup(
        account: string,
        asset: PhotoAsset,
        backedUp: Map<string, string | null>,
        layout: PhotoLayout,
        albumOf: (recordName: string) => string | undefined,
    ): Promise<boolean> {
        const original = pickOriginal(asset);
        if (!original) return false;

        const checksum = original.fileChecksum ?? null;
        if (backedUp.has(asset.recordName) && backedUp.get(asset.recordName) === checksum) return false;

        try {
            const bytes = await this.icloud.download(account, original.downloadURL);
            const group = layoutGroup(layout, { recordName: asset.recordName, assetDate: asset.assetDate }, albumOf);
            const key = this.archive.key(account, asset.recordName, asset.filename, group);
            const size = await this.archive.store(key, bytes, original.fileType);
            await this.store.markBackedUp(account, asset.recordName, { key, size, checksum });
            backedUp.set(asset.recordName, checksum);
            return true;
        } catch (error) {
            this.logger.warn(`[${SYNC_PHOTOS_JOB}] backup failed for ${asset.recordName}: ${String(error)}`);
            return false;
        }
    }

    /**
     * Build a `recordName → album name` map by paging each user album. First
     * album wins for a photo in several. Degrades gracefully: any failure logs
     * and yields an empty map, so album-layout backups still run (everything
     * lands under `Unsorted`) rather than failing.
     */
    private async buildAlbumMap(photos: PhotosService): Promise<Map<string, string>> {
        const map = new Map<string, string>();
        try {
            const albums = await photos.getAlbums();
            for (const album of albums) {
                const name = album.name ?? album.recordName;
                for await (const asset of photos.list({ albumId: album.recordName })) {
                    if (!map.has(asset.recordName)) map.set(asset.recordName, name);
                }
            }
            this.logger.info(`[${SYNC_PHOTOS_JOB}] album membership: ${map.size} assets across ${albums.length} albums`);
        } catch (error) {
            this.logger.warn(`[${SYNC_PHOTOS_JOB}] could not resolve album membership; filing under 'Unsorted': ${String(error)}`);
        }
        return map;
    }
}
