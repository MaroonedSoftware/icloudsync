import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { ICloudError } from '@icloudsync/icloud';
import { Logger } from '@maroonedsoftware/logger';
import { createRegistry } from 'injectkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeServer } from '../_helpers/server.js';
import { registerBodyParser } from '../../src/modules/http/body.parser.js';
import { createApiApp } from '../../src/modules/http/server.js';
import { ICloudService } from '../../src/modules/icloud/icloud.service.js';
import { PhotoArchive } from '../../src/modules/icloud/storage/photo.archive.js';
import { PhotosRepository, type ListPhotosOptions, type ListPhotosResult, type PhotoStats, type SyncedPhoto } from '../../src/modules/icloud/sync/photos.repository.js';
import { SyncRegistry } from '../../src/modules/icloud/sync/sync.registry.js';
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

const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} } as Logger;

const ACCOUNT = 'me@icloud.com';
const acct = `/icloud/accounts/${ACCOUNT}`;

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
    lastList?: { account: string; options: ListPhotosOptions };
    listImpl: () => ListPhotosResult = () => ({ photos: [photo('A')], total: 1 });
    getImpl: (recordName: string) => SyncedPhoto | null = () => null;
    statsImpl: () => PhotoStats = () => STATS;

    list(account: string, options: ListPhotosOptions): Promise<ListPhotosResult> {
        this.lastList = { account, options };
        return Promise.resolve(this.listImpl());
    }
    get(_account: string, recordName: string): Promise<SyncedPhoto | null> {
        return Promise.resolve(this.getImpl(recordName));
    }
    stats(_account: string): Promise<PhotoStats> {
        return Promise.resolve(this.statsImpl());
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
    let syncRegistry: SyncRegistry;
    let icloud: { download: (account: string, url: string) => Promise<Uint8Array>; listAccounts: () => Promise<string[]> };

    beforeEach(() => {
        repo = new FakeRepo();
        broker = new FakeBroker();
        archive = new FakeArchive();
        syncRegistry = new SyncRegistry();
        icloud = { download: async () => new Uint8Array([1, 2, 3]), listAccounts: async () => [ACCOUNT] };

        const registry = createRegistry();
        registry.register(Logger).useInstance(silentLogger);
        registerBodyParser(registry);
        registry.register(ICloudService).useInstance(icloud as unknown as ICloudService);
        registry.register(PhotosRepository).useInstance(repo as unknown as PhotosRepository);
        registry.register(PhotoArchive).useInstance(archive as unknown as PhotoArchive);
        registry.register(JobBroker).useInstance(broker as unknown as JobBroker);
        registry.register(SyncRegistry).useInstance(syncRegistry);
        registry.register(SettingsService).useInstance({ syncCron: async () => '0 */6 * * *' } as unknown as SettingsService);

        server = createApiApp(registry.build()).listen(0);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(() => closeServer(server));

    it('reports backup stats with the schedule and running state', async () => {
        const res = await fetch(`${base}${acct}/stats`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ account: 'me@icloud.com', schedule: '0 */6 * * *', running: false, ...STATS });
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
            account: 'me@icloud.com',
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
        archive.files.set('me@icloud.com/A/A.jpg', new Uint8Array([9, 9, 9, 9]));
        repo.getImpl = () => photo('A', { backupKey: 'me@icloud.com/A/A.jpg', backupSize: 4 });
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

    it('maps an upstream download failure to 502', async () => {
        repo.getImpl = () => photo('A');
        icloud.download = async () => {
            throw new ICloudError('gone', 410);
        };
        const res = await fetch(`${base}${acct}/photos/A/download`);
        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({ details: { reason: 'icloud_upstream_error' } });
    });

    it('enqueues a per-account sync and injects the account into the payload', async () => {
        const res = await fetch(`${base}${acct}/sync`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ smartAlbum: 'FAVORITE', pageSize: 50 }),
        });
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ queued: true, job: 'icloud/sync-photos', jobId: 'job-1' });
        expect(broker.sent).toEqual([{ name: 'icloud/sync-photos', payload: { smartAlbum: 'FAVORITE', pageSize: 50, accountName: ACCOUNT } }]);
    });

    it('enqueues a per-account sync with an empty body', async () => {
        const res = await fetch(`${base}${acct}/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ queued: true, job: 'icloud/sync-photos', jobId: 'job-1' });
        expect(broker.sent).toEqual([{ name: 'icloud/sync-photos', payload: { accountName: ACCOUNT } }]);
    });

    it('fans an all-account sync out into one job per registered account', async () => {
        icloud.listAccounts = async () => ['a@icloud.com', 'b@icloud.com'];
        const res = await fetch(`${base}/icloud/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({
            queued: 2,
            job: 'icloud/sync-photos',
            jobs: [
                { account: 'a@icloud.com', jobId: 'job-1' },
                { account: 'b@icloud.com', jobId: 'job-2' },
            ],
        });
        expect(broker.sent).toEqual([
            { name: 'icloud/sync-photos', payload: { accountName: 'a@icloud.com' } },
            { name: 'icloud/sync-photos', payload: { accountName: 'b@icloud.com' } },
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
        icloud.listAccounts = async () => ['a@icloud.com', 'b@icloud.com'];
        await fetch(`${base}/icloud/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const res = await fetch(`${base}/icloud/sync/cancel`, { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ cancelled: 2 });
        expect(broker.cancelled.sort()).toEqual(['job-1', 'job-2']);
    });
});
