import { describe, expect, it } from 'vitest';
import { PhotosService } from '../src/services/photos.js';
import type { HttpResponse } from '../src/http/client.js';
import type { ICloudRequester } from '../src/services/photos.js';

const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');

function ok<T>(data: T): HttpResponse<T> {
    return { status: 200, headers: new Headers(), data, text: JSON.stringify(data) };
}

function assetRecord(name: string, masterName: string, filename: string, favorite: boolean) {
    return {
        recordName: name,
        recordType: 'CPLAsset',
        recordChangeTag: 'tag1',
        fields: {
            filenameEnc: { value: b64(filename) },
            assetDate: { value: 1_700_000_000 },
            addedDate: { value: 1_700_000_100 },
            isFavorite: { value: favorite ? 1 : 0 },
            isHidden: { value: 0 },
            isDeleted: { value: 0 },
            masterRef: { value: { recordName: masterName, zoneID: { zoneName: 'PrimarySync' } } },
            resJPEGMedRes: { value: { downloadURL: `https://cvws.icloud.com/${name}-med`, size: 1024, fileChecksum: 'chk-med' } },
        },
    };
}

function masterRecord(name: string) {
    return {
        recordName: name,
        recordType: 'CPLMaster',
        recordChangeTag: 'tag1',
        fields: {
            resOriginalRes: { value: { downloadURL: `https://p-content.icloud.com/${name}-orig`, size: 4096, fileChecksum: 'chk-orig' } },
            resOriginalWidth: { value: 3000 },
            resOriginalHeight: { value: 2000 },
            resOriginalFileType: { value: 'public.jpeg' },
        },
    };
}

/** A fake requester scripted to return two assets on the first page, then empty. */
function makeRequester() {
    const calls: Array<{ pathname: string; body: any }> = [];
    const downloads: string[] = [];

    const requester: ICloudRequester = {
        serviceUrl: name => (name === 'ckdatabasews' ? 'https://p01-ckdatabasews.icloud.com:443' : undefined),
        async request<T>(_serviceUrl: string, pathname: string, init?: RequestInit & { json?: unknown }): Promise<HttpResponse<T>> {
            const body = init?.json as any;
            calls.push({ pathname, body });

            if (body?.query?.recordType === 'CPLAlbumByPositionLive') {
                return ok({
                    records: [{ recordName: 'album-1', recordType: 'CPLAlbumByPositionLive', fields: { albumNameEnc: { value: b64('Holiday') } } }],
                }) as HttpResponse<T>;
            }
            if (pathname.includes('records/query/batch')) {
                return ok({
                    batch: [{ records: [{ recordName: 'count', recordType: 'HyperionIndexCountLookup', fields: { itemCount: { value: 42 } } }] }],
                }) as HttpResponse<T>;
            }
            // Paged asset list.
            const startRank = body.query.filterBy.find((f: any) => f.fieldName === 'startRank').fieldValue.value as number;
            if (startRank === 0) {
                return ok({
                    records: [
                        assetRecord('asset-1', 'master-1', 'first.jpg', true),
                        masterRecord('master-1'),
                        assetRecord('asset-2', 'master-2', 'second.heic', false),
                        masterRecord('master-2'),
                    ],
                }) as HttpResponse<T>;
            }
            return ok({ records: [] }) as HttpResponse<T>;
        },
        async download(url: string): Promise<Uint8Array> {
            downloads.push(url);
            return new Uint8Array([1, 2, 3, 4]);
        },
    };

    return { requester, calls, downloads };
}

describe('PhotosService', () => {
    it('pages, pairs asset+master records, and normalizes fields', async () => {
        const { requester, calls } = makeRequester();
        const photos = new PhotosService(requester);

        const assets = await photos.listAll({ pageSize: 50 });
        expect(assets).toHaveLength(2);

        const [first, second] = assets;
        expect(first!.filename).toBe('first.jpg');
        expect(first!.isFavorite).toBe(true);
        expect(first!.masterRecordName).toBe('master-1');
        expect(first!.assetDate).toBe(1_700_000_000);
        // Original rendition from the master record.
        expect(first!.resources.resOriginalRes?.downloadURL).toBe('https://p-content.icloud.com/master-1-orig');
        expect(first!.resources.resOriginalRes?.width).toBe(3000);
        expect(first!.resources.resOriginalRes?.fileType).toBe('public.jpeg');
        // Derived rendition from the asset record.
        expect(first!.resources.resJPEGMedRes?.downloadURL).toBe('https://cvws.icloud.com/asset-1-med');
        expect(second!.filename).toBe('second.heic');
        expect(second!.isFavorite).toBe(false);

        // resultsLimit is pageSize * 2; second page started at rank 2 (two masters).
        const listCalls = calls.filter(c => c.pathname.includes('records/query?'));
        expect(listCalls[0]!.body.resultsLimit).toBe(100);
        expect(listCalls[1]!.body.query.filterBy[0].fieldValue.value).toBe(2);
    });

    it('decodes album names', async () => {
        const { requester } = makeRequester();
        const albums = await new PhotosService(requester).getAlbums();
        expect(albums).toEqual([{ recordName: 'album-1', recordChangeTag: undefined, name: 'Holiday' }]);
    });

    it('reads the asset count from a batch lookup', async () => {
        const { requester } = makeRequester();
        expect(await new PhotosService(requester).getCount()).toBe(42);
    });

    it('downloads the requested rendition', async () => {
        const { requester, downloads } = makeRequester();
        const photos = new PhotosService(requester);
        const [asset] = await photos.listAll();
        const bytes = await photos.download(asset!, 'resOriginalRes');
        expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(downloads).toEqual(['https://p-content.icloud.com/master-1-orig']);
    });

    it('re-looks-up records and rebuilds the asset with fresh rendition URLs', async () => {
        const calls: Array<{ pathname: string; body: any }> = [];
        const requester: ICloudRequester = {
            serviceUrl: name => (name === 'ckdatabasews' ? 'https://p01-ckdatabasews.icloud.com:443' : undefined),
            async request<T>(_url: string, pathname: string, init?: RequestInit & { json?: unknown }): Promise<HttpResponse<T>> {
                calls.push({ pathname, body: init?.json });
                return ok({ records: [assetRecord('asset-1', 'master-1', 'first.jpg', true), masterRecord('master-1')] }) as HttpResponse<T>;
            },
            async download() {
                return new Uint8Array();
            },
        };

        const asset = await new PhotosService(requester).lookup(['asset-1', 'master-1']);
        expect(asset!.recordName).toBe('asset-1');
        expect(asset!.masterRecordName).toBe('master-1');
        // Fresh URLs from both the master (original) and asset (derived) records.
        expect(asset!.resources.resOriginalRes?.downloadURL).toBe('https://p-content.icloud.com/master-1-orig');
        expect(asset!.resources.resJPEGMedRes?.downloadURL).toBe('https://cvws.icloud.com/asset-1-med');
        // Issued a records/lookup carrying the requested record names.
        const lookup = calls.find(c => c.pathname.includes('records/lookup'));
        expect(lookup!.body.records).toEqual([{ recordName: 'asset-1' }, { recordName: 'master-1' }]);
    });

    it('returns undefined when a lookup resolves no asset/master records', async () => {
        const requester: ICloudRequester = {
            serviceUrl: name => (name === 'ckdatabasews' ? 'https://p01-ckdatabasews.icloud.com:443' : undefined),
            async request<T>(): Promise<HttpResponse<T>> {
                return ok({ records: [] }) as HttpResponse<T>;
            },
            async download() {
                return new Uint8Array();
            },
        };
        expect(await new PhotosService(requester).lookup(['nope'])).toBeUndefined();
        expect(await new PhotosService(requester).lookup([])).toBeUndefined();
    });

    it('throws when ckdatabasews is unavailable', async () => {
        const requester: ICloudRequester = {
            serviceUrl: () => undefined,
            request: async () => ok({}),
            download: async () => new Uint8Array(),
        };
        await expect(new PhotosService(requester).getAlbums()).rejects.toThrow(/not authenticated/);
    });

    /** A requester that returns list-query pages from a scripted queue, in order. */
    function scriptedRequester(pages: Array<{ records: unknown[]; continuationMarker?: unknown }>): ICloudRequester {
        let next = 0;
        return {
            serviceUrl: name => (name === 'ckdatabasews' ? 'https://p01-ckdatabasews.icloud.com:443' : undefined),
            async request<T>(_url: string, pathname: string): Promise<HttpResponse<T>> {
                if (!pathname.includes('records/query')) return ok({ records: [] }) as HttpResponse<T>;
                return ok(pages[next++] ?? { records: [] }) as HttpResponse<T>;
            },
            async download() {
                return new Uint8Array();
            },
        };
    }

    it('retries the same rank on a transient empty page that still advertises more', async () => {
        // A blip mid-library: an empty page that still carries a continuationMarker
        // must NOT end the walk — the same rank is retried and the later asset found.
        const photos = new PhotosService(
            scriptedRequester([
                { records: [assetRecord('asset-1', 'master-1', 'first.jpg', false), masterRecord('master-1')] },
                { records: [], continuationMarker: 'more' }, // transient empty
                { records: [assetRecord('asset-2', 'master-2', 'second.jpg', false), masterRecord('master-2')] },
                { records: [] }, // true end: empty, no marker
            ]),
        );

        const assets = await photos.listAll({ pageSize: 1 });
        expect(assets.map(a => a.filename)).toEqual(['first.jpg', 'second.jpg']);
    });

    it('stops after a bounded number of empty retries when the marker lingers', async () => {
        // If CloudKit keeps returning empty+marker past the true end, the walk must
        // still terminate (bounded retries) rather than loop forever.
        const pages = [
            { records: [assetRecord('asset-1', 'master-1', 'first.jpg', false), masterRecord('master-1')] },
            ...Array.from({ length: 20 }, () => ({ records: [] as unknown[], continuationMarker: 'more' })),
        ];
        const photos = new PhotosService(scriptedRequester(pages));

        const assets = await photos.listAll({ pageSize: 1 });
        expect(assets.map(a => a.filename)).toEqual(['first.jpg']);
    });

    it('stops immediately on an empty page with no continuation marker', async () => {
        const photos = new PhotosService(
            scriptedRequester([
                { records: [assetRecord('asset-1', 'master-1', 'first.jpg', false), masterRecord('master-1')] },
                { records: [] }, // no marker → done
                { records: [assetRecord('asset-2', 'master-2', 'unreached.jpg', false), masterRecord('master-2')] },
            ]),
        );

        const assets = await photos.listAll({ pageSize: 1 });
        expect(assets.map(a => a.filename)).toEqual(['first.jpg']);
    });
});
