import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { ICloudError } from '@icloudsync/icloud';
import type { PhotoResource } from '@icloudsync/icloud';
import { Logger } from '@maroonedsoftware/logger';
import { createRegistry } from 'injectkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeServer } from '../_helpers/server.js';
import { registerBodyParser } from '../../src/modules/http/body.parser.js';
import { createApiApp } from '../../src/modules/http/server.js';
import { ICloudService } from '../../src/modules/icloud/icloud.service.js';
import { PhotoArchive } from '../../src/modules/icloud/storage/photo.archive.js';
import { ThumbnailCache } from '../../src/modules/icloud/storage/thumbnail.cache.js';
import { PhotosRepository, type ListPhotosOptions, type ListPhotosResult, type PhotoStats, type SyncedPhoto } from '../../src/modules/icloud/sync/photos.repository.js';
import { SyncRegistry } from '../../src/modules/icloud/sync/sync.registry.js';
import { SyncProgressRegistry } from '../../src/modules/icloud/sync/sync.progress.registry.js';
import { SettingsService } from '../../src/modules/settings/settings.service.js';

/** In-memory archive stand-in; serves bytes for keys it's been seeded with. */
class FakeArchive {
    readonly files = new Map<string, Uint8Array>();
    read(key: string): Promise<Readable> {
        const bytes = this.files.get(key);
        if (!bytes) return Promise.reject(new Error(`no such key ${key}`));
        return Promise.resolve(Readable.from(Buffer.from(bytes)));
    }
}

/** In-memory thumbnail cache stand-in mirroring {@link ThumbnailCache}'s read-through contract. */
class FakeThumbnailCache {
    readonly files = new Map<string, Uint8Array>();
    enabled = true;
    key(accountId: string, recordName: string, resolution: string, checksum?: string | null): string {
        return `${accountId}/${recordName}/${resolution}${checksum ? `-${checksum}` : ''}`;
    }
    read(key: string): Promise<Readable | undefined> {
        if (!this.enabled) return Promise.resolve(undefined);
        const bytes = this.files.get(key);
        return Promise.resolve(bytes ? Readable.from(Buffer.from(bytes)) : undefined);
    }
    store(key: string, bytes: Uint8Array): Promise<void> {
        if (this.enabled) this.files.set(key, bytes);
        return Promise.resolve();
    }
}

const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} } as Logger;

const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const acct = `/icloud/accounts/${ACCOUNT_ID}`;

function photo(recordName: string, overrides: Partial<SyncedPhoto> = {}): SyncedPhoto {
    return {
        recordName,
        masterRecordName: `master-${recordName}`,
        filename: `${recordName}.jpg`,
        assetDate: 1_700_000_000_000,
        addedDate: 1_700_000_100_000,
        isFavorite: false,
        isHidden: false,
        isDeleted: false,
        resources: { resOriginalRes: { key: 'resOriginalRes', downloadURL: `https://content.icloud.com/${recordName}`, size: 1024 } },
        syncedAt: '2026-06-29T00:00:00.000Z',
        backupKey: null,
        backupSize: null,
        backedUpAt: null,
        ...overrides,
    };
}

const STATS: PhotoStats = {
    total: 1234,
    favorites: 56,
    backedUp: 1000,
    backedUpBytes: 5_000_000,
    newestAssetDate: 1_700_000_000_000,
    oldestAssetDate: 1_500_000_000_000,
    lastSyncedAt: '2026-06-29T00:00:00.000Z',
};

/** In-memory stand-in for the repository's read surface. */
class FakeRepo {
    lastList?: { id: string; options: ListPhotosOptions };
    updated?: { id: string; recordName: string; resources: Record<string, unknown> };
    listImpl: () => ListPhotosResult = () => ({ photos: [photo('A')], total: 1 });
    getImpl: (recordName: string) => SyncedPhoto | null = () => null;
    statsImpl: () => PhotoStats = () => STATS;

    list(id: string, options: ListPhotosOptions): Promise<ListPhotosResult> {
        this.lastList = { id, options };
        return Promise.resolve(this.listImpl());
    }
    get(_id: string, recordName: string): Promise<SyncedPhoto | null> {
        return Promise.resolve(this.getImpl(recordName));
    }
    stats(_id: string): Promise<PhotoStats> {
        return Promise.resolve(this.statsImpl());
    }
    updateResources(id: string, recordName: string, resources: Record<string, unknown>): Promise<void> {
        this.updated = { id, recordName, resources };
        return Promise.resolve();
    }
}

/**
 * Captures enqueued jobs (returning a deterministic id each) and tracks their
 * pg-boss state so the routes' `getJob`/`cancel` calls can be asserted.
 */
class FakeBroker {
    readonly sent: Array<{ name: string; payload: unknown }> = [];
    readonly cancelled: string[] = [];
    private readonly jobs = new Map<string, { name: string; state: string; data: unknown }>();
    private seq = 0;

    send(name: string, payload: object): Promise<string> {
        this.sent.push({ name, payload });
        this.seq += 1;
        const id = `job-${this.seq}`;
        this.jobs.set(id, { name, state: 'created', data: payload });
        return Promise.resolve(id);
    }
    getJob(name: string, id: string): Promise<{ id: string; name: string; state: string; data: unknown } | null> {
        const job = this.jobs.get(id);
        return Promise.resolve(job && job.name === name ? { id, ...job } : null);
    }
    cancel(_name: string, id: string | string[]): Promise<void> {
        for (const jobId of Array.isArray(id) ? id : [id]) {
            this.cancelled.push(jobId);
            const job = this.jobs.get(jobId);
            if (job) job.state = 'cancelled';
        }
        return Promise.resolve();
    }
    schedule(): Promise<void> {
        return Promise.resolve();
    }
    unschedule(): Promise<void> {
        return Promise.resolve();
    }
}

describe('icloud photos routes', () => {
    let server: Server;
    let base: string;
    let repo: FakeRepo;
    let broker: FakeBroker;
    let archive: FakeArchive;
    let thumbnails: FakeThumbnailCache;
    let syncRegistry: SyncRegistry;
    let syncProgress: SyncProgressRegistry;
    let icloud: {
        download: (id: string, url: string) => Promise<Uint8Array>;
        refreshRenditions: (id: string, recordName: string, masterRecordName?: string) => Promise<Record<string, PhotoResource> | undefined>;
        listAccounts: () => Promise<Array<{ id: string; account: string }>>;
    };

    beforeEach(() => {
        repo = new FakeRepo();
        broker = new FakeBroker();
        archive = new FakeArchive();
        thumbnails = new FakeThumbnailCache();
        syncRegistry = new SyncRegistry();
        syncProgress = new SyncProgressRegistry();
        icloud = {
            download: async () => new Uint8Array([1, 2, 3]),
            refreshRenditions: async () => undefined,
            listAccounts: async () => [{ id: ACCOUNT_ID, account: 'me@icloud.com' }],
        };

        const registry = createRegistry();
        registry.register(Logger).useInstance(silentLogger);
        registerBodyParser(registry);
        registry.register(ICloudService).useInstance(icloud as unknown as ICloudService);
        registry.register(PhotosRepository).useInstance(repo as unknown as PhotosRepository);
        registry.register(PhotoArchive).useInstance(archive as unknown as PhotoArchive);
        registry.register(ThumbnailCache).useInstance(thumbnails as unknown as ThumbnailCache);
        registry.register(JobBroker).useInstance(broker as unknown as JobBroker);
        registry.register(SyncRegistry).useInstance(syncRegistry);
        registry.register(SyncProgressRegistry).useInstance(syncProgress);
        registry.register(SettingsService).useInstance({ syncCron: async () => '0 */6 * * *' } as unknown as SettingsService);

        server = createApiApp(registry.build()).listen(0);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(() => closeServer(server));

    it('reports backup stats with the schedule and running state', async () => {
        const res = await fetch(`${base}${acct}/stats`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: ACCOUNT_ID, schedule: '0 */6 * * *', running: false, libraryTotal: null, thumbnails: true, ...STATS });
    });

    it('reports the library total pulled at the last sync\'s start', async () => {
        syncProgress.setLibraryTotal(ACCOUNT_ID, 4200);
        const res = await fetch(`${base}${acct}/stats`);
        expect(await res.json()).toMatchObject({ libraryTotal: 4200 });
    });

    it('reports running: true while a sync is queued or active for the account', async () => {
        await fetch(`${base}${acct}/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const res = await fetch(`${base}${acct}/stats`);
        expect(await res.json()).toMatchObject({ running: true });
    });

    it('lists synced photos with paging metadata and defaults', async () => {
        const res = await fetch(`${base}${acct}/photos`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ photos: [photo('A')], total: 1, limit: 50, offset: 0 });
        expect(repo.lastList).toEqual({
            id: ACCOUNT_ID,
            options: { limit: 50, offset: 0, favorite: undefined, includeHidden: undefined, includeDeleted: undefined, order: 'desc' },
        });
    });

    it('passes through filters from the query string', async () => {
        await fetch(`${base}${acct}/photos?limit=10&offset=20&favorite=true&includeHidden=true&order=asc`);
        expect(repo.lastList?.options).toEqual({
            limit: 10,
            offset: 20,
            favorite: true,
            includeHidden: true,
            includeDeleted: undefined,
            order: 'asc',
        });
    });

    it('rejects an out-of-range limit with 400', async () => {
        const res = await fetch(`${base}${acct}/photos?limit=9999`);
        expect(res.status).toBe(400);
    });

    it('rejects a non-UUID account path with 400', async () => {
        const res = await fetch(`${base}/icloud/accounts/not-a-uuid/photos`);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ details: { reason: 'account_required' } });
    });

    it('returns a single photo', async () => {
        repo.getImpl = name => (name === 'A' ? photo('A') : null);
        const res = await fetch(`${base}${acct}/photos/A`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(photo('A'));
    });

    it('404s an unknown photo', async () => {
        const res = await fetch(`${base}${acct}/photos/missing`);
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ details: { reason: 'photo_not_found' } });
    });

    it('downloads a rendition live through the proxy when not archived', async () => {
        repo.getImpl = () => photo('A');
        const res = await fetch(`${base}${acct}/photos/A/download`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        expect(res.headers.get('content-disposition')).toContain('A.jpg');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('serves the archived original from storage when backed up', async () => {
        archive.files.set(`${ACCOUNT_ID}/A/A.jpg`, new Uint8Array([9, 9, 9, 9]));
        repo.getImpl = () => photo('A', { backupKey: `${ACCOUNT_ID}/A/A.jpg`, backupSize: 4 });
        let liveCalled = false;
        icloud.download = async () => {
            liveCalled = true;
            return new Uint8Array([1, 2, 3]);
        };

        const res = await fetch(`${base}${acct}/photos/A/download`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe('4');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9, 9]));
        expect(liveCalled).toBe(false); // served from disk, not iCloud
    });

    it('404s a download for a missing rendition', async () => {
        repo.getImpl = () => photo('A', { resources: {} });
        const res = await fetch(`${base}${acct}/photos/A/download?resolution=resJPEGFullRes`);
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ details: { reason: 'rendition_not_found', resolution: 'resJPEGFullRes' } });
    });

    it('fetches a thumbnail from iCloud, serves it inline, and caches the bytes', async () => {
        repo.getImpl = () =>
            photo('A', {
                resources: { resJPEGThumb: { key: 'resJPEGThumb', downloadURL: 'https://content.icloud.com/A/thumb', fileChecksum: 'chk1' } },
            });
        const res = await fetch(`${base}${acct}/photos/A/download?resolution=resJPEGThumb`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/jpeg');
        expect(res.headers.get('content-disposition')).toBe('inline');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        // The fetched bytes are now cached under the record+resolution+checksum key.
        expect(thumbnails.files.get(`${ACCOUNT_ID}/A/resJPEGThumb-chk1`)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('serves a cached thumbnail without a live iCloud fetch', async () => {
        thumbnails.files.set(`${ACCOUNT_ID}/A/resJPEGThumb-chk1`, new Uint8Array([7, 7, 7]));
        repo.getImpl = () =>
            photo('A', {
                resources: { resJPEGThumb: { key: 'resJPEGThumb', downloadURL: 'https://content.icloud.com/A/thumb', fileChecksum: 'chk1' } },
            });
        let liveCalled = false;
        icloud.download = async () => {
            liveCalled = true;
            return new Uint8Array([1, 2, 3]);
        };

        const res = await fetch(`${base}${acct}/photos/A/download?resolution=resJPEGThumb`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/jpeg');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));
        expect(liveCalled).toBe(false); // served from cache, not iCloud
    });

    it('serves and caches a video rendition inline as video/mp4', async () => {
        repo.getImpl = () =>
            photo('V', {
                resources: {
                    resVidMedRes: { key: 'resVidMedRes', downloadURL: 'https://content.icloud.com/V/vid', fileChecksum: 'vchk' },
                },
            });
        const res = await fetch(`${base}${acct}/photos/V/download?resolution=resVidMedRes`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('video/mp4');
        expect(res.headers.get('content-disposition')).toBe('inline');
        expect(thumbnails.files.get(`${ACCOUNT_ID}/V/resVidMedRes-vchk`)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('refreshes an expired signed URL, persists fresh renditions, and retries', async () => {
        repo.getImpl = () =>
            photo('A', {
                masterRecordName: 'master-A',
                resources: { resJPEGThumb: { key: 'resJPEGThumb', downloadURL: 'https://icloud/expired', fileChecksum: 'chk' } },
            });
        icloud.download = async (_id, url) => {
            if (url === 'https://icloud/expired') throw new ICloudError('Download failed (410)', 410);
            if (url === 'https://icloud/fresh') return new Uint8Array([5, 5, 5]);
            throw new Error(`unexpected url ${url}`);
        };
        const fresh = { resJPEGThumb: { key: 'resJPEGThumb', downloadURL: 'https://icloud/fresh', fileChecksum: 'chk' } };
        let refreshedFor: { recordName: string; master?: string } | undefined;
        icloud.refreshRenditions = async (_id, recordName, master) => {
            refreshedFor = { recordName, master };
            return fresh;
        };

        const res = await fetch(`${base}${acct}/photos/A/download?resolution=resJPEGThumb`);
        expect(res.status).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([5, 5, 5]));
        expect(refreshedFor).toEqual({ recordName: 'A', master: 'master-A' });
        // Fresh renditions are persisted and the retried bytes are cached.
        expect(repo.updated).toEqual({ id: ACCOUNT_ID, recordName: 'A', resources: fresh });
        expect(thumbnails.files.get(`${ACCOUNT_ID}/A/resJPEGThumb-chk`)).toEqual(new Uint8Array([5, 5, 5]));
    });

    it('502s when an expired URL cannot be refreshed', async () => {
        repo.getImpl = () =>
            photo('A', {
                resources: { resJPEGThumb: { key: 'resJPEGThumb', downloadURL: 'https://icloud/expired', fileChecksum: 'chk' } },
            });
        icloud.download = async () => {
            throw new ICloudError('Download failed (410)', 410);
        };
        icloud.refreshRenditions = async () => undefined; // asset gone upstream

        const res = await fetch(`${base}${acct}/photos/A/download?resolution=resJPEGThumb`);
        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({ details: { reason: 'icloud_upstream_error', upstreamStatus: 410 } });
        expect(repo.updated).toBeUndefined();
        // The failure must NOT be cacheable, or the browser replays a broken tile for a day.
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('makes a failed thumbnail fetch non-cacheable but a served one cacheable', async () => {
        // Missing rendition (404) → no-store, so the browser retries once bytes exist.
        repo.getImpl = () => photo('A', { resources: {} });
        const miss = await fetch(`${base}${acct}/photos/A/download?resolution=resJPEGThumb`);
        expect(miss.status).toBe(404);
        expect(miss.headers.get('cache-control')).toBe('no-store');

        // A successful thumbnail is cacheable.
        thumbnails.files.set(`${ACCOUNT_ID}/A/resJPEGThumb-chk1`, new Uint8Array([7, 7, 7]));
        repo.getImpl = () =>
            photo('A', {
                resources: { resJPEGThumb: { key: 'resJPEGThumb', downloadURL: 'https://content.icloud.com/A/thumb', fileChecksum: 'chk1' } },
            });
        const hit = await fetch(`${base}${acct}/photos/A/download?resolution=resJPEGThumb`);
        expect(hit.status).toBe(200);
        expect(hit.headers.get('cache-control')).toBe('private, max-age=86400');
    });

    it('maps an unknown rendition to its CloudKit fileType MIME', async () => {
        repo.getImpl = () =>
            photo('G', {
                resources: {
                    resAltRes: { key: 'resAltRes', downloadURL: 'https://content.icloud.com/G/alt', fileType: 'com.compuserve.gif' },
                },
            });
        const res = await fetch(`${base}${acct}/photos/G/download?resolution=resAltRes`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/gif');
    });

    it('reports thumbnails: false in stats when the cache is disabled', async () => {
        thumbnails.enabled = false;
        const res = await fetch(`${base}${acct}/stats`);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ thumbnails: false });
    });

    it('404s a thumbnail download when thumbnails are disabled, without hitting iCloud', async () => {
        thumbnails.enabled = false;
        repo.getImpl = () =>
            photo('A', {
                resources: { resJPEGThumb: { key: 'resJPEGThumb', downloadURL: 'https://content.icloud.com/A/thumb' } },
            });
        let liveCalled = false;
        icloud.download = async () => {
            liveCalled = true;
            return new Uint8Array([1, 2, 3]);
        };

        const res = await fetch(`${base}${acct}/photos/A/download?resolution=resJPEGThumb`);
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ details: { reason: 'thumbnails_disabled' } });
        expect(liveCalled).toBe(false);
    });

    it('maps an upstream download failure to 502', async () => {
        repo.getImpl = () => photo('A');
        icloud.download = async () => {
            throw new ICloudError('gone', 410);
        };
        const res = await fetch(`${base}${acct}/photos/A/download`);
        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({ details: { reason: 'icloud_upstream_error' } });
    });

    it('enqueues a per-account sync and injects the account id into the payload', async () => {
        const res = await fetch(`${base}${acct}/sync`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ smartAlbum: 'FAVORITE', pageSize: 50 }),
        });
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ queued: true, job: 'icloud/sync-photos', jobId: 'job-1' });
        expect(broker.sent).toEqual([{ name: 'icloud/sync-photos', payload: { smartAlbum: 'FAVORITE', pageSize: 50, accountId: ACCOUNT_ID } }]);
    });

    it('enqueues a per-account sync with an empty body', async () => {
        const res = await fetch(`${base}${acct}/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ queued: true, job: 'icloud/sync-photos', jobId: 'job-1' });
        expect(broker.sent).toEqual([{ name: 'icloud/sync-photos', payload: { accountId: ACCOUNT_ID } }]);
    });

    it('fans an all-account sync out into one job per registered account', async () => {
        icloud.listAccounts = async () => [
            { id: ID_A, account: 'a@icloud.com' },
            { id: ID_B, account: 'b@icloud.com' },
        ];
        const res = await fetch(`${base}/icloud/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({
            queued: 2,
            job: 'icloud/sync-photos',
            jobs: [
                { id: ID_A, jobId: 'job-1' },
                { id: ID_B, jobId: 'job-2' },
            ],
        });
        expect(broker.sent).toEqual([
            { name: 'icloud/sync-photos', payload: { accountId: ID_A } },
            { name: 'icloud/sync-photos', payload: { accountId: ID_B } },
        ]);
    });

    it('rejects an invalid smartAlbum with 400', async () => {
        const res = await fetch(`${base}${acct}/sync`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ smartAlbum: 'NOPE' }),
        });
        expect(res.status).toBe(400);
    });

    it('cancels a running sync for the account by its job id', async () => {
        await fetch(`${base}${acct}/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const res = await fetch(`${base}${acct}/sync/cancel`, { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ cancelled: true });
        expect(broker.cancelled).toEqual(['job-1']);
    });

    it('reports cancelled: false when no sync is tracked for the account', async () => {
        const res = await fetch(`${base}${acct}/sync/cancel`, { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ cancelled: false });
        expect(broker.cancelled).toEqual([]);
    });

    it('cancels every in-flight sync and returns the count', async () => {
        icloud.listAccounts = async () => [
            { id: ID_A, account: 'a@icloud.com' },
            { id: ID_B, account: 'b@icloud.com' },
        ];
        await fetch(`${base}/icloud/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const res = await fetch(`${base}/icloud/sync/cancel`, { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ cancelled: 2 });
        expect(broker.cancelled.sort()).toEqual(['job-1', 'job-2']);
    });
});
