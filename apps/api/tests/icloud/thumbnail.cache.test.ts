import { Readable } from 'node:stream';
import { buffer as readStream } from 'node:stream/consumers';
import { StorageObjectNotFoundError, StorageProvider } from '@maroonedsoftware/storage';
import type {
    SignedUrlOptions,
    StorageListOptions,
    StorageListResult,
    StorageObjectMetadata,
    StorageReadOptions,
    StorageWriteOptions,
} from '@maroonedsoftware/storage';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { ThumbnailCache } from '../../src/modules/icloud/storage/thumbnail.cache.js';

/**
 * In-memory {@link StorageProvider} with a monotonic write clock so eviction
 * ordering (oldest-first by `lastModified`) is deterministic without real time.
 * Only the methods {@link ThumbnailCache} exercises are implemented.
 */
class InMemoryStorage extends StorageProvider {
    readonly objects = new Map<string, { body: Buffer; modified: number }>();
    private clock = 0;

    async write(key: string, body: Readable | Buffer | string): Promise<void> {
        const buf = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : await readStream(body);
        this.clock += 1;
        this.objects.set(key, { body: buf, modified: this.clock });
    }

    read(key: string, _options?: StorageReadOptions): Promise<Readable> {
        const entry = this.objects.get(key);
        if (!entry) return Promise.reject(new StorageObjectNotFoundError(key));
        return Promise.resolve(Readable.from(entry.body));
    }

    delete(key: string): Promise<void> {
        this.objects.delete(key);
        return Promise.resolve();
    }

    list(options?: StorageListOptions): Promise<StorageListResult> {
        const prefix = options?.prefix ?? '';
        const objects: StorageObjectMetadata[] = [...this.objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, entry]) => ({ key, size: entry.body.byteLength, lastModified: DateTime.fromMillis(entry.modified) }));
        return Promise.resolve({ objects, cursor: undefined });
    }

    exists(key: string): Promise<boolean> {
        return Promise.resolve(this.objects.has(key));
    }
    stat(_key: string): Promise<StorageObjectMetadata> {
        throw new Error('not implemented');
    }
    copy(_s: string, _d: string): Promise<void> {
        throw new Error('not implemented');
    }
    move(_s: string, _d: string): Promise<void> {
        throw new Error('not implemented');
    }
    getSignedUrl(_key: string, _options: SignedUrlOptions): Promise<string> {
        throw new Error('not implemented');
    }
}

describe('ThumbnailCache', () => {
    describe('key', () => {
        it('composes account/record/resolution and folds in the checksum', () => {
            const cache = new ThumbnailCache(new InMemoryStorage());
            expect(cache.key('acct', 'REC-1', 'resJPEGThumb', 'chk1')).toBe('acct/REC-1/resJPEGThumb-chk1');
        });

        it('omits the checksum tag when none is given', () => {
            const cache = new ThumbnailCache(new InMemoryStorage());
            expect(cache.key('acct', 'REC-1', 'resJPEGThumb')).toBe('acct/REC-1/resJPEGThumb');
        });

        it('percent-encodes segments so odd ids stay path-safe', () => {
            const cache = new ThumbnailCache(new InMemoryStorage());
            expect(cache.key('a/b', 'r c', 'resJPEGThumb', 'x/y+z')).toBe('a%2Fb/r%20c/resJPEGThumb-x%2Fy%2Bz');
        });
    });

    describe('read', () => {
        it('round-trips stored bytes and returns undefined for a miss', async () => {
            const cache = new ThumbnailCache(new InMemoryStorage());
            expect(await cache.read('acct/r/resJPEGThumb')).toBeUndefined();
            await cache.store('acct/r/resJPEGThumb', new Uint8Array([1, 2, 3]));
            const stream = await cache.read('acct/r/resJPEGThumb');
            expect(stream).toBeDefined();
            expect((await readStream(stream!)).equals(Buffer.from([1, 2, 3]))).toBe(true);
        });
    });

    describe('enabled', () => {
        it('is enabled for a positive budget', () => {
            expect(new ThumbnailCache(new InMemoryStorage(), 1).enabled).toBe(true);
            expect(new ThumbnailCache(new InMemoryStorage()).enabled).toBe(true);
        });

        it('is disabled for a zero budget, and then never reads or writes', async () => {
            const storage = new InMemoryStorage();
            const cache = new ThumbnailCache(storage, 0);
            expect(cache.enabled).toBe(false);
            await cache.store('a', new Uint8Array([1, 2, 3]));
            expect(storage.objects.size).toBe(0); // write was a no-op
            expect(await cache.read('a')).toBeUndefined(); // read always misses
        });
    });

    describe('eviction', () => {
        it('evicts the oldest entries once a write pushes the cache over its budget', async () => {
            const storage = new InMemoryStorage();
            // Budget of 100 bytes → re-measures after 25 bytes written; 40-byte entries force sweeps.
            const cache = new ThumbnailCache(storage, 100);
            const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(1);

            await cache.store('a', bytes(40)); // total 40
            await cache.store('b', bytes(40)); // total 80
            await cache.store('c', bytes(40)); // total 120 > 100 → evict oldest ('a') back to 80

            expect(storage.objects.has('a')).toBe(false); // oldest, evicted
            expect(storage.objects.has('b')).toBe(true);
            expect(storage.objects.has('c')).toBe(true);
            const total = [...storage.objects.values()].reduce((n, o) => n + o.body.byteLength, 0);
            expect(total).toBeLessThanOrEqual(100);
        });

        it('keeps everything while the cache fits under budget', async () => {
            const storage = new InMemoryStorage();
            const cache = new ThumbnailCache(storage, 1000);
            await cache.store('a', new Uint8Array(40).fill(1));
            await cache.store('b', new Uint8Array(40).fill(1));
            expect(storage.objects.has('a')).toBe(true);
            expect(storage.objects.has('b')).toBe(true);
        });

        it('does not cache an item larger than the whole budget (e.g. a big video)', async () => {
            const storage = new InMemoryStorage();
            const cache = new ThumbnailCache(storage, 100);
            await cache.store('big', new Uint8Array(200).fill(1));
            expect(storage.objects.size).toBe(0);
        });
    });
});
