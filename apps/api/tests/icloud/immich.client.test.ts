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

    describe('verify', () => {
        it('resolves when the server pings and the API key is accepted', async () => {
            const { fetch, calls } = stubFetch(url => (url.endsWith('/server/ping') ? { body: { res: 'pong' } } : { body: { id: 'user-1' } }));
            await new ImmichClient('https://immich.test', 'k', 'dev', fetch).verify();
            expect(calls.map(c => c.url)).toEqual(['https://immich.test/api/server/ping', 'https://immich.test/api/users/me']);
            expect((calls[1]!.init?.headers as Record<string, string>)['x-api-key']).toBe('k');
        });

        it('throws (URL) when the server does not answer the ping', async () => {
            const { fetch } = stubFetch(() => ({ status: 404, body: {} }));
            await expect(new ImmichClient('https://immich.test', 'k', 'dev', fetch).verify()).rejects.toMatchObject({ message: expect.stringContaining('URL') });
        });

        it('throws (key rejected) when /users/me returns 401', async () => {
            const { fetch } = stubFetch(url => (url.endsWith('/server/ping') ? { body: { res: 'pong' } } : { status: 401, body: {} }));
            await expect(new ImmichClient('https://immich.test', 'bad', 'dev', fetch).verify()).rejects.toMatchObject({
                status: 401,
                message: expect.stringContaining('key'),
            });
        });
    });

    describe('retry + timeout', () => {
        const ok = new Response(JSON.stringify({ id: 'a', status: 'created' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        const upload = () => ({ deviceAssetId: 'r', filename: 'f', bytes, isFavorite: false });

        it('retries a 429 and succeeds, honoring Retry-After', async () => {
            const sleeps: number[] = [];
            let n = 0;
            const fetch: FetchLike = async () => (++n <= 2 ? new Response('slow', { status: 429, headers: { 'retry-after': '2' } }) : ok);
            const client = new ImmichClient('https://immich.test', 'k', 'dev', fetch, { sleep: async ms => void sleeps.push(ms) });

            expect(await client.upload(upload())).toEqual({ id: 'a', duplicate: false });
            expect(n).toBe(3);
            expect(sleeps).toEqual([2_000, 2_000]);
        });

        it('backs off exponentially when the server sends no Retry-After', async () => {
            const sleeps: number[] = [];
            let n = 0;
            const albums = new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
            const fetch: FetchLike = async () => (++n <= 3 ? new Response('', { status: 502 }) : albums);
            const client = new ImmichClient('https://immich.test', 'k', 'dev', fetch, { sleep: async ms => void sleeps.push(ms) });

            await client.listAlbums();
            expect(sleeps).toEqual([1_000, 2_000, 4_000]);
        });

        it('gives up after maxRetries on a persistent 503', async () => {
            let n = 0;
            const fetch: FetchLike = async () => (n++, new Response('busy', { status: 503 }));
            const client = new ImmichClient('https://immich.test', 'k', 'dev', fetch, { maxRetries: 2, sleep: async () => {} });

            await expect(client.upload(upload())).rejects.toMatchObject({ status: 503 });
            expect(n).toBe(3); // initial attempt + 2 retries
        });

        it('does not retry a permanent 401', async () => {
            let n = 0;
            const fetch: FetchLike = async () => (n++, new Response('nope', { status: 401 }));
            const client = new ImmichClient('https://immich.test', 'k', 'dev', fetch, { sleep: async () => {} });

            await expect(client.upload(upload())).rejects.toMatchObject({ status: 401 });
            expect(n).toBe(1);
        });

        it('does not retry when maxRetries is 0', async () => {
            let n = 0;
            const fetch: FetchLike = async () => (n++, new Response('busy', { status: 503 }));
            const client = new ImmichClient('https://immich.test', 'k', 'dev', fetch, { maxRetries: 0, sleep: async () => {} });

            await expect(client.listAlbums()).rejects.toMatchObject({ status: 503 });
            expect(n).toBe(1);
        });

        it('retries a network failure, then throws ImmichError once retries are exhausted', async () => {
            let n = 0;
            const fetch: FetchLike = async () => {
                n++;
                throw new Error('ECONNREFUSED');
            };
            const client = new ImmichClient('https://immich.test', 'k', 'dev', fetch, { maxRetries: 1, sleep: async () => {} });

            await expect(client.ping()).rejects.toMatchObject({ status: 0, message: expect.stringContaining('ECONNREFUSED') });
            expect(n).toBe(2); // initial attempt + 1 retry
        });
    });
});
