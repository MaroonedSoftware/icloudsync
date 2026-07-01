import { PhotosService } from '@icloudsync/icloud';
import type { HttpResponse, ICloudRequester, PhotoAsset } from '@icloudsync/icloud';
import type { Logger } from '@maroonedsoftware/logger';
import { describe, expect, it } from 'vitest';
import type { PhotoArchive } from '../../src/modules/icloud/storage/photo.archive.js';
import type { PhotoLayout } from '../../src/modules/icloud/storage/photo.layout.js';
import { SyncPhotosJob, type PhotoSyncSource } from '../../src/modules/icloud/sync/sync.photos.job.js';
import type { BackupRecord, PhotoStore } from '../../src/modules/icloud/sync/photos.repository.js';
import type { SettingsService } from '../../src/modules/settings/settings.service.js';

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
            const body = init?.json as QueryBody;
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

class FakeStore implements PhotoStore {
    readonly batches: PhotoAsset[][] = [];
    readonly accounts: string[] = [];
    readonly marks: Array<{ recordName: string; backup: BackupRecord }> = [];
    backedUp = new Map<string, string | null>();

    async upsertBatch(accountName: string, assets: PhotoAsset[]): Promise<number> {
        this.accounts.push(accountName);
        this.batches.push([...assets]);
        return assets.length;
    }
    async backedUpChecksums(): Promise<Map<string, string | null>> {
        return new Map(this.backedUp);
    }
    async markBackedUp(_accountName: string, recordName: string, backup: BackupRecord): Promise<void> {
        this.marks.push({ recordName, backup });
        this.backedUp.set(recordName, backup.checksum);
    }
}

class FakeArchive {
    readonly stored = new Map<string, Uint8Array>();
    key(account: string, recordName: string, filename?: string, group?: string): string {
        const leaf = filename ? `${recordName}/${filename}` : recordName;
        return group ? `${account}/${group}/${leaf}` : `${account}/${leaf}`;
    }
    async store(key: string, bytes: Uint8Array): Promise<number> {
        this.stored.set(key, bytes);
        return bytes.byteLength;
    }
}

function source(opts: { authenticated: boolean; count: number; downloads?: string[]; albums?: AlbumFixture[]; accounts?: string[] }): PhotoSyncSource {
    return {
        listAccounts: async () => opts.accounts ?? ['me@icloud.com'],
        isAuthenticated: () => opts.authenticated,
        restoreAccount: async () => opts.authenticated,
        photos: () => photosWith(opts.count, opts.albums),
        download: async (_account: string, url: string) => {
            opts.downloads?.push(url);
            return new Uint8Array([1, 2, 3, 4]);
        },
    };
}

const archive = (): PhotoArchive => new FakeArchive() as unknown as PhotoArchive;
const settings = (layout: PhotoLayout = 'flat'): SettingsService => ({ photosLayout: async () => layout }) as unknown as SettingsService;

describe('SyncPhotosJob', () => {
    it('pages all photos and upserts them in batches', async () => {
        const store = new FakeStore();
        const job = new SyncPhotosJob(source({ authenticated: true, count: 5 }), store, archive(), silentLogger, settings());

        await job.run({ batchSize: 2, pageSize: 10, metadataOnly: true, accountName: 'me@icloud.com' });

        // 5 assets at batchSize 2 -> batches of 2, 2, 1.
        expect(store.batches.map(b => b.length)).toEqual([2, 2, 1]);
        const all = store.batches.flat();
        expect(all).toHaveLength(5);
        expect(all[0]!.filename).toBe('photo-0.jpg');
        expect(all[0]!.resources.resOriginalRes?.downloadURL).toBe('https://x/0');
        // metadataOnly -> nothing archived.
        expect(store.marks).toHaveLength(0);
    });

    it('downloads and archives original bytes, recording each backup', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const downloads: string[] = [];
        const job = new SyncPhotosJob(source({ authenticated: true, count: 3, downloads }), store, arc as unknown as PhotoArchive, silentLogger, settings());

        await job.run({ batchSize: 10, accountName: 'me@icloud.com' });

        expect(downloads.sort()).toEqual(['https://x/0', 'https://x/1', 'https://x/2']);
        expect(arc.stored.size).toBe(3);
        expect(arc.stored.get('me@icloud.com/asset-0/photo-0.jpg')).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(store.marks).toHaveLength(3);
        expect(store.marks[0]!.backup).toMatchObject({ key: 'me@icloud.com/asset-0/photo-0.jpg', size: 4, checksum: 'sum-0' });
    });

    it('skips re-downloading originals whose checksum is unchanged', async () => {
        const store = new FakeStore();
        store.backedUp = new Map([
            ['asset-0', 'sum-0'],
            ['asset-1', 'sum-1'],
        ]);
        const downloads: string[] = [];
        const job = new SyncPhotosJob(source({ authenticated: true, count: 3, downloads }), store, archive(), silentLogger, settings());

        await job.run({ batchSize: 10, accountName: 'me@icloud.com' });

        // Only the new asset-2 is fetched; the two unchanged ones are skipped.
        expect(downloads).toEqual(['https://x/2']);
        expect(store.marks.map(m => m.recordName)).toEqual(['asset-2']);
    });

    it('organizes archived files by capture date under the date layout', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const job = new SyncPhotosJob(source({ authenticated: true, count: 2 }), store, arc as unknown as PhotoArchive, silentLogger, settings('date'));

        await job.run({ batchSize: 10, accountName: 'me@icloud.com' });

        // ASSET_DATE is 2024-03-09 -> 2024/2024-03.
        expect([...arc.stored.keys()].sort()).toEqual([
            'me@icloud.com/2024/2024-03/asset-0/photo-0.jpg',
            'me@icloud.com/2024/2024-03/asset-1/photo-1.jpg',
        ]);
    });

    it('organizes archived files by album, with non-album photos under Unsorted', async () => {
        const store = new FakeStore();
        const arc = new FakeArchive();
        const albums: AlbumFixture[] = [{ recordName: 'alb-1', name: 'Vacation', assetIds: [0, 1] }];
        // run-level layout override exercises the album path; asset-2 is in no album.
        const job = new SyncPhotosJob(source({ authenticated: true, count: 3, albums }), store, arc as unknown as PhotoArchive, silentLogger, settings());

        await job.run({ batchSize: 10, layout: 'album', accountName: 'me@icloud.com' });

        expect([...arc.stored.keys()].sort()).toEqual([
            'me@icloud.com/Unsorted/asset-2/photo-2.jpg',
            'me@icloud.com/Vacation/asset-0/photo-0.jpg',
            'me@icloud.com/Vacation/asset-1/photo-1.jpg',
        ]);
    });

    it('syncs the single account named in the payload', async () => {
        const store = new FakeStore();
        const job = new SyncPhotosJob(
            source({ authenticated: true, count: 1, accounts: ['a@icloud.com', 'b@icloud.com'] }),
            store,
            archive(),
            silentLogger,
            settings(),
        );

        await job.run({ batchSize: 10, metadataOnly: true, accountName: 'b@icloud.com' });

        expect(store.accounts).toEqual(['b@icloud.com']);
    });

    it('does nothing when the payload names no account', async () => {
        const store = new FakeStore();
        const job = new SyncPhotosJob(source({ authenticated: true, count: 5 }), store, archive(), silentLogger, settings());

        await job.run();

        expect(store.batches).toHaveLength(0);
    });

    it('skips the run when the account is not authenticated', async () => {
        const store = new FakeStore();
        const job = new SyncPhotosJob(source({ authenticated: false, count: 5 }), store, archive(), silentLogger, settings());

        await job.run({ accountName: 'me@icloud.com' });

        expect(store.batches).toHaveLength(0);
    });

    it('writes nothing for an empty library', async () => {
        const store = new FakeStore();
        const job = new SyncPhotosJob(source({ authenticated: true, count: 0 }), store, archive(), silentLogger, settings());

        await job.run({ batchSize: 2, accountName: 'me@icloud.com' });

        expect(store.batches).toHaveLength(0);
    });

    it('skips the sync when its signal is already aborted before it starts', async () => {
        const store = new FakeStore();
        const downloads: string[] = [];
        const job = new SyncPhotosJob(source({ authenticated: true, count: 5, downloads }), store, archive(), silentLogger, settings());
        const controller = new AbortController();
        controller.abort(); // cancelled during the enqueue window, before the runner handed it over

        await job.run({ batchSize: 10, accountName: 'me@icloud.com' }, controller.signal);

        expect(store.batches).toHaveLength(0);
        expect(downloads).toHaveLength(0);
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
        const job = new SyncPhotosJob(src, store, archive(), silentLogger, settings());

        await job.run({ batchSize: 10, accountName: 'me@icloud.com' }, controller.signal);

        expect(downloads).toHaveLength(1);
    });
});
