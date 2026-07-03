import { describe, expect, it } from 'vitest';
import { ImmichClient, ImmichError, type FetchLike } from '../../src/modules/icloud/storage/immich.client.js';

/** A fetch stub that records calls and serves queued JSON responses. */
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }): {
    fetch: FetchLike;
    calls: Array<{ url: string; init?: RequestInit }>;
} {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: FetchLike = async (url, init) => {
        calls.push({ url, init });
        const { status = 200, body } = handler(url, init);
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    };
    return { fetch, calls };
}

const bytes = new Uint8Array([1, 2, 3, 4]);

describe('ImmichClient', () => {
    it('normalizes the base URL to <origin>/api', async () => {
        const { fetch, calls } = stubFetch(() => ({ body: { res: 'pong' } }));
        await new ImmichClient('https://immich.test/', 'k', 'dev', fetch).ping();
        await new ImmichClient('https://immich.test/api', 'k', 'dev', fetch).ping();
        expect(calls[0]!.url).toBe('https://immich.test/api/server/ping');
        expect(calls[1]!.url).toBe('https://immich.test/api/server/ping');
    });

    it('uploads an asset with the api key header and returns the id', async () => {
        const { fetch, calls } = stubFetch(() => ({ body: { id: 'asset-xyz', status: 'created' } }));
        const client = new ImmichClient('https://immich.test', 'secret', 'dev', fetch);

        const result = await client.upload({ deviceAssetId: 'rec-1', filename: 'IMG_1.HEIC', bytes, isFavorite: true, assetDate: Date.UTC(2024, 0, 1) });

        expect(result).toEqual({ id: 'asset-xyz', duplicate: false });
        expect(calls[0]!.url).toBe('https://immich.test/api/assets');
        expect(calls[0]!.init?.method).toBe('POST');
        expect((calls[0]!.init?.headers as Record<string, string>)['x-api-key']).toBe('secret');
    });

    it('reports a duplicate upload', async () => {
        const { fetch } = stubFetch(() => ({ body: { id: 'existing', status: 'duplicate' } }));
        const client = new ImmichClient('https://immich.test', 'k', 'dev', fetch);
        expect(await client.upload({ deviceAssetId: 'r', filename: 'f', bytes, isFavorite: false })).toEqual({ id: 'existing', duplicate: true });
    });

    it('creates an album and adds assets to it', async () => {
        const { fetch, calls } = stubFetch(url => {
            if (url.endsWith('/albums') ) return { body: { id: 'album-1' } };
            return { body: [{ id: 'a', success: true }] };
        });
        const client = new ImmichClient('https://immich.test', 'k', 'dev', fetch);

        const albumId = await client.createAlbum('Vacation', ['a1']);
        await client.addToAlbum(albumId, ['a2', 'a3']);

        expect(albumId).toBe('album-1');
        expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ albumName: 'Vacation', assetIds: ['a1'] });
        expect(calls[1]!.url).toBe('https://immich.test/api/albums/album-1/assets');
        expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ ids: ['a2', 'a3'] });
    });

    it('skips the network call when adding an empty asset list', async () => {
        const { fetch, calls } = stubFetch(() => ({ body: [] }));
        await new ImmichClient('https://immich.test', 'k', 'dev', fetch).addToAlbum('album-1', []);
        expect(calls).toHaveLength(0);
    });

    it('throws ImmichError on a non-2xx response', async () => {
        const { fetch } = stubFetch(() => ({ status: 401, body: { message: 'unauthorized' } }));
        const client = new ImmichClient('https://immich.test', 'bad', 'dev', fetch);
        await expect(client.upload({ deviceAssetId: 'r', filename: 'f', bytes, isFavorite: false })).rejects.toBeInstanceOf(ImmichError);
    });
});
