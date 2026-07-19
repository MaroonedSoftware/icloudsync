import type { Readable } from 'node:stream';
import { StorageObjectMetadata, StorageObjectNotFoundError, StorageProvider } from '@maroonedsoftware/storage';

/** Subdirectory (under the photos root) the thumbnail cache is stored in by default. */
export const THUMBNAIL_CACHE_DIR = '.thumbnails';

/** Default cap on the cache's on-disk footprint (bytes). Thumbnails are tiny, so even this holds hundreds. */
export const DEFAULT_THUMBNAIL_CACHE_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Make an arbitrary id safe to use as a single storage-key path segment. */
function segment(value: string): string {
    return encodeURIComponent(value);
}

/** Millis of a list entry's last-modified time, or 0 when the backend didn't report one. */
function modifiedAt(object: StorageObjectMetadata): number {
    return object.lastModified?.toMillis() ?? 0;
}

/**
 * On-disk (or bucket) cache of small, derived renditions — grid thumbnails and
 * previews — so the download proxy can serve them without a live iCloud fetch.
 *
 * A rendition's iCloud `downloadURL` is a CloudKit *signed* URL that expires
 * within hours of a sync; without a cache every grid thumbnail re-hits iCloud and
 * turns into a broken image once that signature lapses (or the session does).
 * Bytes are cached by content — keyed on the account, record, rendition, and the
 * rendition's checksum — so a re-synced photo with changed content misses and
 * re-fetches rather than serving a stale thumbnail.
 *
 * The cache is **bounded**: its total footprint is capped at `maxBytes`, and once
 * a write pushes it over, the oldest entries (by last-modified time) are evicted
 * until it fits again — a rolling window that keeps only the most-recently-cached
 * thumbnails. Eviction is FIFO by write time (not true LRU): the disk backend
 * doesn't track read access, and the only consumer shows a small, recent set, so
 * "newest wins" is the right rotation. An evicted thumbnail is simply re-fetched
 * and re-cached the next time its tile is shown, so trimming is always safe.
 *
 * To keep eviction off the hot path, the footprint is only re-measured after
 * roughly a quarter of the budget has been written since the last check, so most
 * cache misses just write and return; growth between checks is bounded by that
 * slack. Delegates byte I/O to a {@link StorageProvider} rooted at its own
 * directory, so listing for eviction walks only cached thumbnails, never the
 * durable photo archive.
 *
 * A `maxBytes` of `0` (or less) turns the cache off entirely: {@link enabled} is
 * `false`, reads always miss and writes are no-ops. Callers gate on
 * {@link enabled} to disable thumbnail serving altogether rather than fall back
 * to an uncached (and thus always-expiring) live fetch.
 */
export class ThumbnailCache {
    /** Whether thumbnail caching (and thus thumbnail serving) is enabled — `false` when the budget is zero. */
    readonly enabled: boolean;
    /** Bytes written since the footprint was last measured; triggers an eviction sweep when it crosses the slack. */
    private bytesSinceCheck = 0;
    /** Re-measure the footprint once this many bytes have been written since the last sweep. */
    private readonly checkEveryBytes: number;

    constructor(
        private readonly storage: StorageProvider,
        private readonly maxBytes: number = DEFAULT_THUMBNAIL_CACHE_MAX_BYTES,
        private readonly prefix: string = '',
    ) {
        this.enabled = maxBytes > 0;
        this.checkEveryBytes = Math.max(1, Math.floor(maxBytes / 4));
    }

    /**
     * The cache key for one account's rendition. The content `checksum` (when the
     * asset carries one) is folded in so changed content lands on a fresh key
     * instead of colliding with the stale copy; renditions without a checksum
     * fall back to a bare `record/resolution` key.
     */
    key(accountId: string, recordName: string, resolution: string, checksum?: string | null): string {
        const tag = checksum ? `-${segment(checksum)}` : '';
        return `${this.prefix}${segment(accountId)}/${segment(recordName)}/${segment(resolution)}${tag}`;
    }

    /** Open a stream of the cached bytes, or `undefined` when nothing is cached under `key` (or the cache is disabled). */
    async read(key: string): Promise<Readable | undefined> {
        if (!this.enabled) return undefined;
        try {
            return await this.storage.read(key);
        } catch (error) {
            if (error instanceof StorageObjectNotFoundError) return undefined;
            throw error;
        }
    }

    /**
     * Cache rendition bytes under `key`, then bound the footprint (throttled).
     * Best-effort — caching, and its eviction, are an optimization, never a
     * correctness requirement, so callers treat failures as a cache miss.
     */
    async store(key: string, bytes: Uint8Array, contentType?: string): Promise<void> {
        // Skip anything larger than the whole budget (e.g. a big video clip): caching
        // it would only evict everything else and then itself on the same sweep.
        if (!this.enabled || bytes.byteLength > this.maxBytes) return;
        await this.storage.write(key, Buffer.from(bytes), contentType ? { contentType } : undefined);
        this.bytesSinceCheck += bytes.byteLength;
        if (this.bytesSinceCheck >= this.checkEveryBytes) {
            this.bytesSinceCheck = 0;
            await this.evict();
        }
    }

    /**
     * Trim the cache to `maxBytes`, deleting the oldest entries first. A no-op when
     * the cache already fits. Tolerant of a not-yet-created cache directory (treated
     * as empty).
     */
    private async evict(): Promise<void> {
        const objects = await this.listAll();
        let total = objects.reduce((sum, object) => sum + object.size, 0);
        if (total <= this.maxBytes) return;
        objects.sort((a, b) => modifiedAt(a) - modifiedAt(b)); // oldest first
        for (const object of objects) {
            if (total <= this.maxBytes) break;
            await this.storage.delete(object.key);
            total -= object.size;
        }
    }

    /** Every cached object's metadata, paging through the backend. Empty if the cache dir doesn't exist yet. */
    private async listAll(): Promise<StorageObjectMetadata[]> {
        const all: StorageObjectMetadata[] = [];
        let cursor: string | undefined;
        try {
            do {
                const page = await this.storage.list({ prefix: this.prefix || undefined, cursor });
                all.push(...page.objects);
                cursor = page.cursor;
            } while (cursor);
        } catch {
            // No cache directory yet (or an unreadable backend) — nothing to evict.
            return [];
        }
        return all;
    }
}
