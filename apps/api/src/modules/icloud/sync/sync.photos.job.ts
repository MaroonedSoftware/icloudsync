import { Job } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { RateLimitError } from '@icloudsync/icloud';
import type { ListOptions, PhotoAsset, PhotoResource, PhotosService, SmartAlbum, SortDirection } from '@icloudsync/icloud';
import { PhotoArchive } from '../storage/photo.archive.js';
import { layoutGroup, type PhotoLayout } from '../storage/photo.layout.js';
import { namingLeaf, shortHash, withSuffix, type PhotoNaming } from '../storage/photo.naming.js';
import {
    DEFAULT_FILESYSTEM_PRESET,
    destinationNeedsAlbums,
    filesystemDestination,
    PRESET_MECHANICS,
    type Destination,
    type FilesystemPreset,
} from '../storage/photo.destination.js';
import { defaultArchivePrefix } from '../storage/photo.prefix.js';
import { buildSidecar, sidecarKey } from '../storage/photo.sidecar.js';
import { SyncProgressRegistry } from './sync.progress.registry.js';
import type { BackedUpAsset, PhotoStore } from './photos.repository.js';

/** The pg-boss queue name for the photo-sync job. pg-boss only allows
 * alphanumerics, `_`, `-`, `.`, `/` in names — no colons. */
export const SYNC_PHOTOS_JOB = 'icloud/sync-photos';

/** Rendition keys that hold the full-resolution original (photo, then video). */
const ORIGINAL_KEYS = ['resOriginalRes', 'resOriginalVidComplRes'];

/**
 * How many times one run will wait out an iCloud rate limit and resume before
 * giving up and leaving the rest for the next scheduled sweep. The client
 * already retries individual 429s; this bounds the coarser, whole-run backoff.
 */
const MAX_RATE_LIMIT_DEFERRALS = 2;
/** Fallback wait when a 429 carries no `Retry-After` hint. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 30_000;
/** Cap on any single in-run wait, so a large `Retry-After` doesn't park a worker for ages. */
const MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000;

/** Sleep for `ms`, resolving early (without rejecting) if `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
        const done = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
}

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
    /**
     * Force a full re-sync: re-download and re-store every asset's bytes even when
     * an up-to-date backup is already recorded (default false). Use to rebuild the
     * archive from scratch. Idempotent — copies overwrite in place — so it re-does
     * work without duplicating it.
     */
    force?: boolean;
    /** Override the on-disk organization for this run (defaults to the account override, else the built-in layout). */
    layout?: PhotoLayout;
    /** Override the archived-filename scheme for this run (defaults to the account override, else the built-in naming). */
    naming?: PhotoNaming;
    /** The id of the account to sync. Always set by the producer ({@link enqueueSync}); a run without it is a no-op. */
    accountId?: string;
}

/** Identity + storage config for one account, as the job needs it. */
export interface AccountRef {
    id: string;
    /** Apple ID email (for human-readable logs and notifications). */
    accountName: string;
    /** Custom photo-archive path prefix, or `null` to default to the Apple ID's local part. */
    archivePrefix: string | null;
}

/**
 * The per-account surface the job needs. {@link AccountsService} satisfies it
 * structurally: {@link getById} resolves the Apple ID and archive prefix, and
 * {@link photoSettings} resolves the layout/naming overrides (each `null` field
 * falls back to the built-in default).
 */
export interface AccountSource {
    /** The account's identity + storage config, or `undefined` if it is gone. */
    getById(id: string): Promise<AccountRef | undefined>;
    /** An account's preset + layout/naming overrides (`null` fields fall back to the built-in default). */
    photoSettings(id: string): Promise<{ preset: FilesystemPreset | null; layout: PhotoLayout | null; naming: PhotoNaming | null }>;
}

/**
 * The reauth-notification surface the job needs. {@link NotificationsService}
 * satisfies it structurally; kept minimal so the job can be tested with a fake.
 */
export interface ReauthReporter {
    /** Alert the admin that an account's session expired and it needs re-login (throttled by id). */
    notifyReauthRequired(accountId: string, appleId: string): Promise<void>;
    /** Note that an account is authenticated again (resets its alert throttle). */
    clearReauth(accountId: string): Promise<void>;
}

/**
 * The minimal iCloud surface the job needs. {@link ICloudService} satisfies it
 * structurally, so the job can be unit-tested with a lightweight fake.
 */
export interface PhotoSyncSource {
    /** Restore an account's persisted session; returns whether it is authenticated. */
    restoreAccount(accountId: string): Promise<boolean>;
    /** Whether the account currently has an authenticated session loaded. */
    isAuthenticated(accountId: string): boolean;
    /** The Photos service for an account, scoped to a CloudKit zone (default `PrimarySync`). */
    photos(accountId: string, zoneName?: string): Promise<PhotosService>;
    /** Download bytes from a signed iCloud rendition URL using the account's session. */
    download(accountId: string, url: string): Promise<Uint8Array>;
}

/**
 * Background job that backs up **one** iCloud Photos library: it pages the
 * library, upserts every asset's metadata into Postgres in batches, then
 * downloads the original bytes and archives them via {@link PhotoArchive}. Both
 * steps are idempotent — metadata upserts key on `(account_id, record)`, and an
 * asset's bytes are re-fetched only when its checksum changes — so a re-run
 * resumes rather than redoing work.
 *
 * The account to sync is named by id in `payload.accountId`; the producer
 * ({@link enqueueSync}) always sets it, and the scheduled sweep fans out one
 * job per account (see {@link SweepPhotosJob}). The account's session is
 * restored first; if it isn't authenticated (e.g. the trust token expired), the
 * run is skipped with a log rather than failing the queue.
 *
 * iCloud rate limiting (HTTP 429) is handled at two levels: the client retries
 * individual requests honoring `Retry-After`, and if a 429 still surfaces as a
 * {@link RateLimitError}, this job waits out the server-requested backoff (capped)
 * and resumes paging from the last flushed rank rather than restarting the pass at
 * rank 0. Each resume that makes forward progress resets the give-up budget, so a
 * large first-time backup can span many short waits; only after
 * {@link MAX_RATE_LIMIT_DEFERRALS} consecutive no-progress deferrals does it stop
 * cleanly, leaving the remainder for the next scheduled sweep rather than failing.
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
        /** Alerts the admin when an account needs re-authentication. Optional (notifications may be off). */
        private readonly notifications?: ReauthReporter,
        /** Resolves the Apple ID, archive prefix, and layout/naming overrides. Optional; when absent the account id is used as the label/prefix and every account falls back to the built-in default (with a source present, an unpinned prefix defaults to the Apple ID's local part). */
        private readonly accounts?: AccountSource,
        /** Records the library size counted at each sync's start, for the dashboard's progress denominator. Optional; when absent no pre-sync count is pulled. */
        private readonly progress?: SyncProgressRegistry,
        /** Sleep between rate-limit deferrals; injectable so tests need not wait on real timers. */
        private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = delay,
    ) {
        super();
    }

    async run(payload: SyncPhotosPayload = {}, signal?: AbortSignal): Promise<void> {
        const accountId = payload.accountId;
        if (!accountId) {
            this.logger.warn(`[${SYNC_PHOTOS_JOB}] no account in payload; nothing to sync`);
            return;
        }
        await this.backupAccount(accountId, payload, signal);
    }

    /**
     * The account backup itself, run under an optional cancellation
     * {@link AbortSignal} (absent only in tests that don't exercise cancel). The
     * signal is polled between pages and between per-asset downloads, so a cancel
     * request stops the run promptly and cleanly: batches already flushed stay
     * committed, and a resumed run picks up where this one left off (metadata
     * upserts and byte archival are both idempotent).
     */
    private async backupAccount(accountId: string, payload: SyncPhotosPayload, signal?: AbortSignal): Promise<void> {
        // Resolve the Apple ID (for logs/alerts) and archive prefix; fall back to
        // the id when no account source is wired (lightweight tests). When no
        // custom prefix is pinned, default to the Apple ID's local part.
        const account = await this.accounts?.getById(accountId);
        const label = account?.accountName ?? accountId;
        const prefix = account?.archivePrefix ?? (account ? defaultArchivePrefix(account) : accountId);

        if (signal?.aborted) {
            this.logger.info(`[${SYNC_PHOTOS_JOB}] sync of ${label} cancelled before it started`);
            return;
        }

        const authenticated = await this.icloud.restoreAccount(accountId);
        if (!authenticated) {
            this.logger.warn(`[${SYNC_PHOTOS_JOB}] account ${label} is not authenticated; skipping`);
            await this.notifications?.notifyReauthRequired(accountId, label);
            return;
        }
        // Authenticated: reset any reauth-alert throttle so a future break notifies promptly.
        await this.notifications?.clearReauth(accountId);

        const batchSize = payload.batchSize ?? 200;
        const backupBytes = !payload.metadataOnly;
        const listOptions: ListOptions = {};
        if (payload.direction) listOptions.direction = payload.direction;
        if (payload.pageSize) listOptions.pageSize = payload.pageSize;
        if (payload.smartAlbum) listOptions.smartAlbum = payload.smartAlbum;

        // Skip set (+ existing keys) so re-runs don't re-download unchanged originals.
        const backedUp = backupBytes ? await this.store.backedUp(accountId) : new Map<string, BackedUpAsset>();
        const photos = await this.icloud.photos(accountId, payload.zoneName);
        // Pull the library's asset count up front (one lightweight query, before we
        // page) so the dashboard's progress denominator is the real total from the
        // start rather than climbing as metadata is synced. Best-effort: a failure
        // (or a smart-album run, whose total wouldn't match the whole-library count)
        // just leaves it unset, and the UI falls back to the rows-synced count.
        await this.recordLibraryTotal(accountId, label, photos, payload);
        // Resolve how this account's photos are filed — only needed when backing
        // up bytes (a metadata-only run touches no destination).
        const destination = backupBytes ? await this.resolveDestination(accountId, payload) : undefined;

        // Album membership is resolved once and reused across rate-limit resumes:
        // it doesn't change mid-run, and re-paging every album on each deferral
        // would burn request budget and invite more throttling. Left undefined
        // until the first pass builds it, so a 429 while building just retries.
        let albums: Map<string, string> | undefined;

        // Where the next pass resumes from. Advanced only past *fully-flushed*
        // batches, so a rate-limit deferral picks up where the last one stopped
        // instead of re-paging the whole library from rank 0. `total`/`archived`
        // ride alongside as cumulative counters so the progress log keeps climbing
        // across resumes rather than restarting from zero each pass.
        let resumeRank = 0;
        let total = 0;
        let archived = 0;

        // One pass over the remaining library, starting at `resumeRank`. Throws a
        // RateLimitError (from paging, album resolution, or a download) when iCloud
        // throttles us past the client's own 429 retries; the defer loop below waits
        // it out and resumes from the last flushed rank. Idempotent, so a resumed
        // pass skips already-archived originals.
        const runPass = async (): Promise<void> => {
            // Resolve which album each asset belongs to when the destination needs it
            // (album layout / XMP sidecars), once, and reuse it on every resume.
            if (albums === undefined) {
                albums = backupBytes && destination && destinationNeedsAlbums(destination) ? await this.buildAlbumMap(photos) : new Map<string, string>();
            }
            const albumOf = (recordName: string): string | undefined => albums!.get(recordName);

            let batch: PhotoAsset[] = [];

            const flush = async (): Promise<void> => {
                if (batch.length === 0) return;
                total += await this.store.upsertBatch(accountId, batch);
                if (backupBytes) {
                    for (const asset of batch) {
                        if (signal?.aborted) break; // stop downloading mid-batch when cancelled
                        // `destination` is always set here: it's resolved above for every byte-backup run.
                        if (await this.backup(accountId, prefix, asset, backedUp, destination!, albumOf, payload.force)) archived += 1;
                    }
                }
                // Advance the resume cursor only after the batch fully flushed
                // (metadata *and* any downloads). A download that throws a rate limit
                // leaves `resumeRank` at this batch's start, so the resumed pass
                // re-fetches its un-archived originals rather than skipping them.
                // The advance is by `batch.length` (ranks paged, duplicates included),
                // which matches how the list generator moves its own rank cursor.
                resumeRank += batch.length;
                this.logger.info(`[${SYNC_PHOTOS_JOB}] ${total} synced, ${archived} archived for ${label}`);
                batch = [];
            };

            for await (const asset of photos.list({ ...listOptions, startRank: resumeRank })) {
                if (signal?.aborted) break; // stop paging when cancelled
                batch.push(asset);
                if (batch.length >= batchSize) await flush();
            }
            if (signal?.aborted) {
                this.logger.info(`[${SYNC_PHOTOS_JOB}] sync of ${label} cancelled: ${total} synced, ${archived} archived so far`);
                return;
            }
            await flush();

            this.logger.info(`[${SYNC_PHOTOS_JOB}] sync complete: ${total} synced, ${archived} archived for ${label}`);
        };

        // Wait out iCloud rate limiting rather than failing the run. When a 429
        // survives the client's retries, back off for the server-requested
        // `Retry-After` (capped) and resume from the last flushed rank. The give-up
        // budget counts only *consecutive* deferrals that made no forward progress:
        // a resume that advanced the cursor resets it, so a large first-time backup
        // can span many short waits, while a genuinely stuck run still bails and
        // leaves the rest for the next scheduled sweep.
        for (let noProgress = 0; ; ) {
            const rankBefore = resumeRank;
            try {
                await runPass();
                return;
            } catch (error) {
                if (!(error instanceof RateLimitError)) throw error;
                if (signal?.aborted) return;
                // A pass that advanced the cursor clears the no-progress tally, so a
                // large backup can span many waits; only genuinely stuck runs count up.
                if (resumeRank > rankBefore) noProgress = 0;
                if (noProgress >= MAX_RATE_LIMIT_DEFERRALS) {
                    this.logger.warn(
                        `[${SYNC_PHOTOS_JOB}] ${label} still rate limited by iCloud after ${noProgress} deferrals with no progress; leaving the rest for the next scheduled sync`,
                    );
                    return;
                }
                noProgress += 1;
                const waitMs = Math.min(error.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS, MAX_RATE_LIMIT_WAIT_MS);
                this.logger.warn(
                    `[${SYNC_PHOTOS_JOB}] ${label} rate limited by iCloud; waiting ${Math.round(waitMs / 1000)}s before resuming from rank ${resumeRank} (deferral ${noProgress}/${MAX_RATE_LIMIT_DEFERRALS})`,
                );
                await this.wait(waitMs, signal);
                if (signal?.aborted) return;
            }
        }
    }

    /**
     * Count the library's assets up front and stash it in the progress registry so
     * the dashboard can show a stable "X of <total>" while the sync runs. Skipped
     * when no registry is wired or the run is scoped to a smart album (its subset
     * wouldn't match the whole-library count). Best-effort — the count is only for
     * display, so a failure is logged and the sync proceeds without it.
     */
    private async recordLibraryTotal(accountId: string, label: string, photos: PhotosService, payload: SyncPhotosPayload): Promise<void> {
        if (!this.progress || payload.smartAlbum) return;
        try {
            const total = await photos.getCount();
            this.progress.setLibraryTotal(accountId, total);
            this.logger.info(`[${SYNC_PHOTOS_JOB}] ${label} library holds ${total} assets`);
        } catch (error) {
            this.logger.warn(`[${SYNC_PHOTOS_JOB}] could not read library count for ${label}: ${String(error)}`);
        }
    }

    /**
     * Resolve the effective backup destination for this run. The filesystem preset
     * is a per-account choice; its layout/naming resolve most-specific first
     * (per-run payload override, else the account's own override, else the preset's
     * baseline). The preset also dictates XMP-sidecar behavior.
     */
    private async resolveDestination(accountId: string, payload: SyncPhotosPayload): Promise<Destination> {
        const override = (await this.accounts?.photoSettings(accountId)) ?? { preset: null, layout: null, naming: null };
        const preset = override.preset ?? DEFAULT_FILESYSTEM_PRESET;
        const baseline = PRESET_MECHANICS[preset];
        const layout = payload.layout ?? override.layout ?? baseline.layout;
        const naming = payload.naming ?? override.naming ?? baseline.naming;
        return filesystemDestination(preset, { layout, naming });
    }

    /**
     * Download and back up an asset's original bytes unless an up-to-date copy
     * already exists. `force` bypasses the skip entirely for a full re-sync.
     * Returns whether it stored anything.
     */
    private async backup(
        accountId: string,
        prefix: string,
        asset: PhotoAsset,
        backedUp: Map<string, BackedUpAsset>,
        destination: Destination,
        albumOf: (recordName: string) => string | undefined,
        force?: boolean,
    ): Promise<boolean> {
        const original = pickOriginal(asset);
        if (!original) return false;

        const checksum = original.fileChecksum ?? null;
        const existing = backedUp.get(asset.recordName);
        // Skip an up-to-date copy; a checksum mismatch re-runs the backup.
        if (!force && existing && existing.checksum === checksum) return false;

        try {
            const bytes = await this.icloud.download(accountId, original.downloadURL);
            const key = await this.archiveToDisk(prefix, asset, bytes, original.fileType, destination, albumOf, existing?.key ?? null);
            if (key === null) return false;
            await this.store.markBackedUp(accountId, asset.recordName, { key, size: bytes.byteLength, checksum });
            backedUp.set(asset.recordName, { checksum, key });
            return true;
        } catch (error) {
            // Rate limiting is a whole-run condition, not a per-asset one: let it
            // bubble so the run backs off instead of hammering the next download.
            if (error instanceof RateLimitError) throw error;
            this.logger.warn(`[${SYNC_PHOTOS_JOB}] backup failed for ${asset.recordName}: ${String(error)}`);
            return false;
        }
    }

    /** Archive bytes to the filesystem under the chosen layout/naming, writing an XMP sidecar when the preset asks for one. Returns the storage key. */
    private async archiveToDisk(
        prefix: string,
        asset: PhotoAsset,
        bytes: Uint8Array,
        contentType: string | undefined,
        destination: Destination,
        albumOf: (recordName: string) => string | undefined,
        recordedKey: string | null,
    ): Promise<string> {
        const group = layoutGroup(destination.layout, { recordName: asset.recordName, assetDate: asset.assetDate }, albumOf);
        const leaf = namingLeaf(destination.naming, { recordName: asset.recordName, filename: asset.filename, assetDate: asset.assetDate });
        const key = await this.resolveKey(prefix, leaf, group, asset.recordName, destination.naming, recordedKey);
        await this.archive.store(key, bytes, contentType);
        if (destination.sidecars) await this.writeSidecar(key, asset, albumOf);
        return key;
    }

    /**
     * Write an XMP sidecar (`<key>.xmp`) carrying the favorite rating, album
     * membership, and capture date for an Immich external-library scan. A no-op
     * when the asset has nothing worth recording (see {@link buildSidecar}).
     */
    private async writeSidecar(key: string, asset: PhotoAsset, albumOf: (recordName: string) => string | undefined): Promise<void> {
        const album = albumOf(asset.recordName);
        const xmp = buildSidecar({
            filename: asset.filename,
            assetDate: asset.assetDate,
            isFavorite: asset.isFavorite,
            albums: album ? [album] : [],
        });
        if (!xmp) return;
        await this.archive.store(sidecarKey(key), new TextEncoder().encode(xmp), 'application/xml');
    }

    /**
     * Resolve the final storage key for an asset, keeping same-named photos from
     * clobbering each other now that files sit directly in their layout folder
     * (no per-photo `recordName` sub-folder). The composed key is used as-is when
     * it is free, or already this asset's own prior copy (a re-sync overwriting in
     * place). Only when a *different* asset already occupies the name is a stable
     * per-record suffix appended (`IMG_0001~a1b2c3.HEIC`), so the result stays
     * deterministic across runs.
     *
     * The `hash` scheme already embeds that suffix, so its keys are unique by
     * construction and skip the existence check entirely.
     */
    private async resolveKey(
        prefix: string,
        leaf: string,
        group: string | undefined,
        recordName: string,
        naming: PhotoNaming,
        recordedKey: string | null,
    ): Promise<string> {
        const key = this.archive.key(prefix, leaf, group);
        if (naming === 'hash' || recordedKey === key) return key; // unique by construction, or our own copy
        if (!(await this.archive.exists(key))) return key; // name is free
        return this.archive.key(prefix, withSuffix(leaf, `~${shortHash(recordName)}`), group); // collision: disambiguate
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
            // Don't degrade to 'Unsorted' on a rate limit: surface it so the run backs off and resumes.
            if (error instanceof RateLimitError) throw error;
            this.logger.warn(`[${SYNC_PHOTOS_JOB}] could not resolve album membership; filing under 'Unsorted': ${String(error)}`);
        }
        return map;
    }
}
