import { PhotosService, RateLimitError } from '@icloudsync/icloud';
import type { HttpResponse, ICloudRequester, PhotoAsset } from '@icloudsync/icloud';
import type { Logger } from '@maroonedsoftware/logger';
import { describe, expect, it } from 'vitest';
import type { PhotoArchive } from '../../src/modules/icloud/storage/photo.archive.js';
import type { PhotoLayout } from '../../src/modules/icloud/storage/photo.layout.js';
import type { FilesystemPreset } from '../../src/modules/icloud/storage/photo.destination.js';
import { SyncPhotosJob, type AccountSource, type PhotoSyncSource } from '../../src/modules/icloud/sync/sync.photos.job.js';
import { SyncProgressRegistry } from '../../src/modules/icloud/sync/sync.progress.registry.js';
import type { BackedUpAsset, BackupRecord, PhotoStore } from '../../src/modules/icloud/sync/photos.repository.js';
import { shortHash, type PhotoNaming } from '../../src/modules/icloud/storage/photo.naming.js';

const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');
const ok = <T>(data: T): HttpResponse<T> => ({ status: 200, headers: new Headers(), data, text: JSON.stringify(data) });

const silentLogger: Logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

const ASSET_DATE = Date.UTC(2024, 2, 9); // 2024-03-09

function assetRecord(i: number) {
    return {
        recordName: `asset-${i}`,
        recordType: 'CPLAsset',
        fields: {
            filenameEnc: { value: b64(`photo-${i}.jpg`) },
            assetDate: { value: ASSET_DATE },
            isFavorite: { value: 0 },
            isHidden: { value: 0 },
            isDeleted: { value: 0 },
            masterRef: { value: { recordName: `master-${i}` } },
        },
    };
}
const masterRecord = (i: number) => ({
    recordName: `master-${i}`,
    recordType: 'CPLMaster',
    fields: { resOriginalRes: { value: { downloadURL: `https://x/${i}`, fileChecksum: `sum-${i}` } } },
});

/** Album fixture: a name and the asset indices it contains. */
interface AlbumFixture {
    recordName: string;
    name: string;
    assetIds: number[];
}

interface QueryBody {
    query: { recordType: string; filterBy?: Array<{ fieldName: string; fieldValue: { value: unknown } }> };
}

/**
 * A requester that serves `count` assets from the main stream, the given user
 * `albums`, and each album's members (so the album layout can be exercised).
 */
function photosWith(count: number, albums: AlbumFixture[] = []): PhotosService {
    const page = (ids: number[]) => ids.flatMap(i => [assetRecord(i), masterRecord(i)]);
    const requester: ICloudRequester = {
        serviceUrl: () => 'https://p01-ckdatabasews.icloud.com:443',
        async request<T>(_u: string, _p: string, init?: RequestInit & { json?: unknown }): Promise<HttpResponse<T>> {
            const body = init?.json as QueryBody & { batch?: unknown };
            // getCount() queries the batch count endpoint; report the library size (= count).
            if (body.batch) {
                return ok({ batch: [{ records: [{ fields: { itemCount: { value: count } } }] }] }) as HttpResponse<T>;
            }
            const { recordType, filterBy } = body.query;

            if (recordType === 'CPLAlbumByPositionLive') {
                const records = albums.map(a => ({ recordName: a.recordName, recordType, fields: { albumNameEnc: { value: b64(a.name) } } }));
                return ok({ records }) as HttpResponse<T>;
            }

            const startRank = Number(filterBy?.find(f => f.fieldName === 'startRank')?.fieldValue.value ?? 0);
            if (startRank > 0) return ok({ records: [] }) as HttpResponse<T>;

            if (recordType === 'CPLContainerRelationLiveByAssetDate') {
                const parentId = filterBy?.find(f => f.fieldName === 'parentId')?.fieldValue.value;
                const album = albums.find(a => a.recordName === parentId);
                return ok({ records: page(album?.assetIds ?? []) }) as HttpResponse<T>;
            }

            return ok({ records: page(Array.from({ length: count }, (_, i) => i)) }) as HttpResponse<T>;
        },
        download: async () => new Uint8Array(),
    };
    return new PhotosService(requester);
}

/**
 * A PhotosService whose main-stream list query throws {@link RateLimitError}
 * the first `failTimes` times it is called, then serves `count` assets. Exercises
 * a 429 surfacing from paging (as opposed to a download).
 */
function rateLimitedPhotos(count: number, failTimes: number, retryAfterMs?: number): PhotosService {
    let listCalls = 0;
    const page = (ids: number[]) => ids.flatMap(i => [assetRecord(i), masterRecord(i)]);
    const requester: ICloudRequester = {
        serviceUrl: () => 'https://p01-ckdatabasews.icloud.com:443',
        async request<T>(_u: string, _p: string, init?: RequestInit & { json?: unknown }): Promise<HttpResponse<T>> {
            const body = init?.json as QueryBody;
            const { recordType, filterBy } = body.query;
            if (recordType === 'CPLAlbumByPositionLive') return ok({ records: [] }) as HttpResponse<T>;
            const startRank = Number(filterBy?.find(f => f.fieldName === 'startRank')?.fieldValue.value ?? 0);
            if (startRank > 0) return ok({ records: [] }) as HttpResponse<T>;
            listCalls += 1;
            if (listCalls <= failTimes) throw new RateLimitError('rate limited', 429, 'slow down', retryAfterMs);
            return ok({ records: page(Array.from({ length: count }, (_, i) => i)) }) as HttpResponse<T>;
        },
        download: async () => new Uint8Array([1, 2, 3, 4]),
    };
    return new PhotosService(requester);
}

class FakeStore implements PhotoStore {
    readonly batches: PhotoAsset[][] = [];
    readonly accounts: string[] = [];
    readonly marks: Array<{ recordName: string; backup: BackupRecord }> = [];
    existing = new Map<string, BackedUpAsset>();

    async upsertBatch(accountName: string, assets: PhotoAsset[]): Promise<number> {
        this.accounts.push(accountName);
        this.batches.push([...assets]);
        return assets.length;
    }
    async backedUp(): Promise<Map<string, BackedUpAsset>> {
        return new Map(this.existing);
    }
    async markBackedUp(_accountName: string, recordName: string, backup: BackupRecord): Promise<void> {
        this.marks.push({ recordName, backup });
        this.existing.set(recordName, { checksum: backup.checksum, key: backup.key });
    }
}

class FakeArchive {
    readonly stored = new Map<string, Uint8Array>();
    key(account: string, leaf: string, group?: string): string {
        return group ? `${account}/${group}/${leaf}` : `${account}/${leaf}`;
    }
    exists(key: string): Promise<boolean> {
        return Promise.resolve(this.stored.has(key));
    }
    async store(key: string, bytes: Uint8Array): Promise<number> {
        this.stored.set(key, bytes);
        return bytes.byteLength;
    }
}

function source(opts: { authenticated: boolean; count: number; downloads?: string[]; albums?: AlbumFixture[] }): PhotoSyncSource {
    return {
        isAuthenticated: () => opts.authenticated,
        restoreAccount: async () => opts.authenticated,
        photos: async () => photosWith(opts.count, opts.albums),
        download: async (_account: string, url: string) => {
            opts.downloads?.push(url);
            return new Uint8Array([1, 2, 3, 4]);
        },
    };
}

const archive = (): PhotoArchive => new FakeArchive() as unknown as PhotoArchive;

/**
 * A per-account source returning the given overrides for every account (prefix
 * pinned to the id). `over` pins the preset; unset fields (and layout/naming) fall
 * back to the built-in defaults (`immich` preset).
 */
const accountSettings = (
    layout: PhotoLayout | null = null,
    naming: PhotoNaming | null = null,
    over: { preset?: FilesystemPreset | null } = {},
): AccountSource => ({
    getById: async (id: string) => ({ id, accountName: id, archivePrefix: id }),
    photoSettings: async () => ({ preset: over.preset ?? null, layout, naming }),
});

describe('SyncPhotosJob', () => {
    it('pages all photos and upserts them in batches', async () => {
        const store = new FakeStore();
        const job = new SyncPhotosJob(source({ authenticated: true, count: 5 }), store, archive(), silentLogger);

        await job.run({ batchSize: 2, pageSize: 10, metadataOnly: true, accountId: 'me@icloud.com' });

        // 5 assets at batchSize 2 -> batches of 2, 2, 1.
        expect(store.batches.map(b => b.length)).toEqual([2, 2, 1]);
        const all = store.batches.flat();
        expect(all).toHaveLength(5);
        expect(all[0]!.filename).toBe('photo-0.jpg');
        expect(all[0]!.resources.resOriginalRes?.downloadURL).toBe('https://x/0');
        // metadataOnly -> nothing archived.
        expect(store.marks).toHaveLength(0);
    });

    it('records the library asset count up front so the dashboard shows a stable total', async () => {
        const progress = new SyncProgressRegistry();
        const job = new SyncPhotosJob(source({ authenticated: true, count: 7 }), new FakeStore(), archive(), silentLogger, undefined, undefined, progress);

        await job.run({ batchSize: 10, metadataOnly: true, accountId: 'me@icloud.com' });

        expect(progress.libraryTotal('me@icloud.com')).toBe(7);
    });

    it('skips the library count for a smart-album run (its subset would not match the whole-library count)', async () => {
        const progress = new SyncProgressRegistry();
        const job = new SyncPhotosJob(source({ authenticated: true, count: 3 }), new FakeStore(), archive(), silentLogger, undefined, undefined, progress);

        await job.run({ batchSize: 10, metadataOnly: true, smartAlbum: 'FAVORITE', accountId: 'me@icloud.com' });

        expect(progress.libraryTotal('me@icloud.com')).toBeUndefined();
    });

    it('downloads and archives original bytes, recording each backup', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const downloads: string[] = [];
        const job = new SyncPhotosJob(source({ authenticated: true, count: 3, downloads }), store, arc as unknown as PhotoArchive, silentLogger);

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        expect(downloads.sort()).toEqual(['https://x/0', 'https://x/1', 'https://x/2']);
        expect(arc.stored.size).toBe(3);
        expect(arc.stored.get('me@icloud.com/photo-0.jpg')).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(store.marks).toHaveLength(3);
        expect(store.marks[0]!.backup).toMatchObject({ key: 'me@icloud.com/photo-0.jpg', size: 4, checksum: 'sum-0' });
    });

    it('skips re-downloading originals whose checksum is unchanged', async () => {
        const store = new FakeStore();
        store.existing = new Map([
            ['asset-0', { checksum: 'sum-0', key: 'me@icloud.com/photo-0.jpg' }],
            ['asset-1', { checksum: 'sum-1', key: 'me@icloud.com/photo-1.jpg' }],
        ]);
        const downloads: string[] = [];
        const job = new SyncPhotosJob(source({ authenticated: true, count: 3, downloads }), store, archive(), silentLogger);

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        // Only the new asset-2 is fetched; the two unchanged ones are skipped.
        expect(downloads).toEqual(['https://x/2']);
        expect(store.marks.map(m => m.recordName)).toEqual(['asset-2']);
    });

    it('organizes archived files by capture date under the date layout', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const job = new SyncPhotosJob(
            source({ authenticated: true, count: 2 }),
            store,
            arc as unknown as PhotoArchive,
            silentLogger,
            undefined,
            accountSettings('date', null),
        );

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        // ASSET_DATE is 2024-03-09 -> 2024/2024-03.
        expect([...arc.stored.keys()].sort()).toEqual([
            'me@icloud.com/2024/2024-03/photo-0.jpg',
            'me@icloud.com/2024/2024-03/photo-1.jpg',
        ]);
    });

    it('organizes archived files by album, with non-album photos under Unsorted', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const albums: AlbumFixture[] = [{ recordName: 'alb-1', name: 'Vacation', assetIds: [0, 1] }];
        // run-level layout override exercises the album path; asset-2 is in no album.
        // The account pins the browsable preset, which keeps sidecars off so the assertion is just the image keys.
        const job = new SyncPhotosJob(
            source({ authenticated: true, count: 3, albums }),
            store,
            arc as unknown as PhotoArchive,
            silentLogger,
            undefined,
            accountSettings(null, null, { preset: 'browsable' }),
        );

        await job.run({ batchSize: 10, layout: 'album', accountId: 'me@icloud.com' });

        expect([...arc.stored.keys()].sort()).toEqual([
            'me@icloud.com/Unsorted/photo-2.jpg',
            'me@icloud.com/Vacation/photo-0.jpg',
            'me@icloud.com/Vacation/photo-1.jpg',
        ]);
    });

    it('names archived files with the date-time scheme when configured', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        // ASSET_DATE is 2024-03-09 00:00:00 UTC -> 20240309-000000.
        const job = new SyncPhotosJob(
            source({ authenticated: true, count: 2 }),
            store,
            arc as unknown as PhotoArchive,
            silentLogger,
            undefined,
            accountSettings(null, 'datetime'),
        );

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        expect([...arc.stored.keys()].sort()).toEqual([
            'me@icloud.com/20240309-000000_photo-0.jpg',
            'me@icloud.com/20240309-000000_photo-1.jpg',
        ]);
    });

    it('names archived files with a per-record hash when the hash scheme is configured', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const job = new SyncPhotosJob(
            source({ authenticated: true, count: 1 }),
            store,
            arc as unknown as PhotoArchive,
            silentLogger,
            undefined,
            accountSettings(null, 'hash'),
        );

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        expect([...arc.stored.keys()]).toEqual([`me@icloud.com/photo-0~${shortHash('asset-0')}.jpg`]);
    });

    it('honors a per-run naming override from the payload', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        // Configured scheme is clean; the payload override forces hash for this run.
        const job = new SyncPhotosJob(source({ authenticated: true, count: 1 }), store, arc as unknown as PhotoArchive, silentLogger);

        await job.run({ batchSize: 10, naming: 'hash', accountId: 'me@icloud.com' });

        expect([...arc.stored.keys()]).toEqual([`me@icloud.com/photo-0~${shortHash('asset-0')}.jpg`]);
    });

    it('disambiguates when a different asset already occupies the clean name', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        // A different asset already holds the clean key; the sync must not clobber it.
        arc.stored.set('me@icloud.com/photo-0.jpg', new Uint8Array([9, 9]));
        const job = new SyncPhotosJob(source({ authenticated: true, count: 1 }), store, arc as unknown as PhotoArchive, silentLogger);

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        const suffixed = `me@icloud.com/photo-0~${shortHash('asset-0')}.jpg`;
        expect(arc.stored.has(suffixed)).toBe(true);
        expect(arc.stored.get('me@icloud.com/photo-0.jpg')).toEqual(new Uint8Array([9, 9])); // untouched
        expect(store.marks[0]!.backup.key).toBe(suffixed);
    });

    it('overwrites its own prior copy in place on re-sync (no false collision)', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const cleanKey = 'me@icloud.com/photo-0.jpg';
        // asset-0 already backed up here with an older checksum; its bytes are on disk.
        store.existing = new Map([['asset-0', { checksum: 'old', key: cleanKey }]]);
        arc.stored.set(cleanKey, new Uint8Array([0]));
        const job = new SyncPhotosJob(source({ authenticated: true, count: 1 }), store, arc as unknown as PhotoArchive, silentLogger);

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        // Same key reused (overwritten), no `~hash` sibling created.
        expect([...arc.stored.keys()]).toEqual([cleanKey]);
        expect(arc.stored.get(cleanKey)).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(store.marks[0]!.backup.key).toBe(cleanKey);
    });

    it('applies an account override over the preset baseline', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        // Preset baseline is flat/clean; this account overrides layout to date.
        const job = new SyncPhotosJob(
            source({ authenticated: true, count: 1 }),
            store,
            arc as unknown as PhotoArchive,
            silentLogger,
            undefined,
            accountSettings('date', null),
        );

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        // date layout from the override, clean naming from the preset baseline.
        expect([...arc.stored.keys()]).toEqual(['me@icloud.com/2024/2024-03/photo-0.jpg']);
    });

    it('lets a per-run payload override beat the account override', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const job = new SyncPhotosJob(
            source({ authenticated: true, count: 1 }),
            store,
            arc as unknown as PhotoArchive,
            silentLogger,
            undefined,
            accountSettings('album', 'datetime'),
        );

        // Payload pins flat/clean, overriding both the account override and the preset baseline.
        await job.run({ batchSize: 10, layout: 'flat', naming: 'clean', accountId: 'me@icloud.com' });

        expect([...arc.stored.keys()]).toEqual(['me@icloud.com/photo-0.jpg']);
    });

    it('immich preset writes an XMP sidecar next to an album asset', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const albums: AlbumFixture[] = [{ recordName: 'alb-1', name: 'Vacation', assetIds: [0] }];
        const job = new SyncPhotosJob(source({ authenticated: true, count: 1, albums }), store, arc as unknown as PhotoArchive, silentLogger);

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        // Flat + clean bytes, plus a sidecar carrying the album membership.
        expect([...arc.stored.keys()].sort()).toEqual(['me@icloud.com/photo-0.jpg', 'me@icloud.com/photo-0.jpg.xmp']);
        const xmp = Buffer.from(arc.stored.get('me@icloud.com/photo-0.jpg.xmp')!).toString('utf-8');
        expect(xmp).toContain('<rdf:li>Vacation</rdf:li>');
        // The recorded backup key is the asset itself, not the sidecar.
        expect(store.marks[0]!.backup.key).toBe('me@icloud.com/photo-0.jpg');
    });

    it('immich preset writes no sidecar for an ordinary photo (no album, not a favorite)', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const job = new SyncPhotosJob(source({ authenticated: true, count: 1 }), store, arc as unknown as PhotoArchive, silentLogger);

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        expect([...arc.stored.keys()]).toEqual(['me@icloud.com/photo-0.jpg']);
    });

    it('force re-syncs every asset even when an up-to-date backup exists', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const downloads: string[] = [];
        // Both assets are already archived to the filesystem with matching checksums —
        // a normal run would skip them; force must re-download and re-store both.
        store.existing = new Map([
            ['asset-0', { checksum: 'sum-0', key: 'me@icloud.com/photo-0.jpg' }],
            ['asset-1', { checksum: 'sum-1', key: 'me@icloud.com/photo-1.jpg' }],
        ]);
        const job = new SyncPhotosJob(source({ authenticated: true, count: 2, downloads }), store, arc as unknown as PhotoArchive, silentLogger);

        await job.run({ batchSize: 10, force: true, accountId: 'me@icloud.com' });

        expect(downloads.sort()).toEqual(['https://x/0', 'https://x/1']);
        expect(store.marks.map(m => m.recordName).sort()).toEqual(['asset-0', 'asset-1']);
    });

    it('syncs the single account named in the payload', async () => {
        const store = new FakeStore();
        const job = new SyncPhotosJob(source({ authenticated: true, count: 1 }), store, archive(), silentLogger);

        await job.run({ batchSize: 10, metadataOnly: true, accountId: 'b@icloud.com' });

        expect(store.accounts).toEqual(['b@icloud.com']);
    });

    it('does nothing when the payload names no account', async () => {
        const store = new FakeStore();
        const job = new SyncPhotosJob(source({ authenticated: true, count: 5 }), store, archive(), silentLogger);

        await job.run();

        expect(store.batches).toHaveLength(0);
    });

    it('skips the run when the account is not authenticated', async () => {
        const store = new FakeStore();
        const job = new SyncPhotosJob(source({ authenticated: false, count: 5 }), store, archive(), silentLogger);

        await job.run({ accountId: 'me@icloud.com' });

        expect(store.batches).toHaveLength(0);
    });

    it('writes nothing for an empty library', async () => {
        const store = new FakeStore();
        const job = new SyncPhotosJob(source({ authenticated: true, count: 0 }), store, archive(), silentLogger);

        await job.run({ batchSize: 2, accountId: 'me@icloud.com' });

        expect(store.batches).toHaveLength(0);
    });

    it('skips the sync when its signal is already aborted before it starts', async () => {
        const store = new FakeStore();
        const downloads: string[] = [];
        const job = new SyncPhotosJob(source({ authenticated: true, count: 5, downloads }), store, archive(), silentLogger);
        const controller = new AbortController();
        controller.abort(); // cancelled during the enqueue window, before the runner handed it over

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' }, controller.signal);

        expect(store.batches).toHaveLength(0);
        expect(downloads).toHaveLength(0);
    });

    it('waits out a rate-limited download and resumes, archiving the asset', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const downloads: string[] = [];
        const src = source({ authenticated: true, count: 1, downloads });
        const inner = src.download;
        let attempts = 0;
        src.download = async (account: string, url: string) => {
            attempts += 1;
            if (attempts === 1) throw new RateLimitError('rate limited', 429, 'slow down', 1234);
            return inner(account, url);
        };
        const waits: number[] = [];
        const job = new SyncPhotosJob(src, store, arc as unknown as PhotoArchive, silentLogger, undefined, undefined, undefined, async ms => {
            waits.push(ms);
        });

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        expect(waits).toEqual([1234]); // honored the RateLimitError's Retry-After hint
        expect(attempts).toBe(2); // first attempt throttled, retried after backoff
        expect(arc.stored.size).toBe(1);
        expect(store.marks.map(m => m.recordName)).toEqual(['asset-0']);
    });

    it('waits out a rate-limited page listing and resumes', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const src: PhotoSyncSource = {
            isAuthenticated: () => true,
            restoreAccount: async () => true,
            photos: async () => rateLimitedPhotos(2, 1, 555),
            download: async () => new Uint8Array([1, 2, 3, 4]),
        };
        const waits: number[] = [];
        const job = new SyncPhotosJob(src, store, arc as unknown as PhotoArchive, silentLogger, undefined, undefined, undefined, async ms => {
            waits.push(ms);
        });

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        expect(waits).toEqual([555]);
        expect(arc.stored.size).toBe(2);
    });

    it('gives up after the deferral limit and leaves the rest for the next sweep', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const src = source({ authenticated: true, count: 1 });
        src.download = async () => {
            throw new RateLimitError('rate limited', 429, 'slow down', 500);
        };
        const waits: number[] = [];
        const job = new SyncPhotosJob(src, store, arc as unknown as PhotoArchive, silentLogger, undefined, undefined, undefined, async ms => {
            waits.push(ms);
        });

        // Resolves (does not throw): a persistent 429 defers rather than failing the run.
        await expect(job.run({ batchSize: 10, accountId: 'me@icloud.com' })).resolves.toBeUndefined();

        expect(waits).toEqual([500, 500]); // MAX_RATE_LIMIT_DEFERRALS backoffs, then give up
        expect(arc.stored.size).toBe(0);
    });

    it('falls back to a default wait when the 429 carries no Retry-After', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const src = source({ authenticated: true, count: 1 });
        let attempts = 0;
        const inner = src.download;
        src.download = async (account: string, url: string) => {
            attempts += 1;
            if (attempts === 1) throw new RateLimitError('rate limited', 429); // no retryAfterMs
            return inner(account, url);
        };
        const waits: number[] = [];
        const job = new SyncPhotosJob(src, store, arc as unknown as PhotoArchive, silentLogger, undefined, undefined, undefined, async ms => {
            waits.push(ms);
        });

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' });

        expect(waits).toEqual([30_000]); // DEFAULT_RATE_LIMIT_WAIT_MS
        expect(arc.stored.size).toBe(1);
    });

    it('stops backing off when its signal is aborted mid-wait', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const controller = new AbortController();
        const src = source({ authenticated: true, count: 1 });
        src.download = async () => {
            throw new RateLimitError('rate limited', 429, 'slow down', 500);
        };
        const waits: number[] = [];
        // Abort during the backoff so the deferral loop bails instead of resuming.
        const job = new SyncPhotosJob(src, store, arc as unknown as PhotoArchive, silentLogger, undefined, undefined, undefined, async ms => {
            waits.push(ms);
            controller.abort();
        });

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' }, controller.signal);

        expect(waits).toEqual([500]); // one wait, then the abort short-circuits the loop
        expect(arc.stored.size).toBe(0);
    });

    it('stops downloading the rest of a batch once its signal is aborted mid-run', async () => {
        const store = new FakeStore();
        const downloads: string[] = [];
        const controller = new AbortController();
        const src = source({ authenticated: true, count: 5, downloads });
        // Abort right after the first download; the signal check in the batch loop halts the rest.
        const download = src.download;
        src.download = async (account: string, url: string) => {
            const bytes = await download(account, url);
            controller.abort();
            return bytes;
        };
        const job = new SyncPhotosJob(src, store, archive(), silentLogger);

        await job.run({ batchSize: 10, accountId: 'me@icloud.com' }, controller.signal);

        expect(downloads).toHaveLength(1);
    });
});
