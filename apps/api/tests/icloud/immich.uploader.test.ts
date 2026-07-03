import { describe, expect, it } from 'vitest';
import type { ImmichClient, ImmichAsset } from '../../src/modules/icloud/storage/immich.client.js';
import { ImmichUploader } from '../../src/modules/icloud/storage/immich.uploader.js';
import type { ImmichDestination } from '../../src/modules/icloud/storage/photo.destination.js';

/** Records what the uploader asks the client to do; resolves an album by name. */
class FakeClient {
    readonly uploads: ImmichAsset[] = [];
    readonly created: string[] = [];
    readonly adds: Array<{ albumId: string; ids: string[] }> = [];
    listCalls = 0;
    existingAlbums: Array<{ id: string; albumName: string }> = [];

    async upload(asset: ImmichAsset) {
        this.uploads.push(asset);
        return { id: `id-${asset.deviceAssetId}`, duplicate: false };
    }
    async listAlbums() {
        this.listCalls += 1;
        return this.existingAlbums;
    }
    async createAlbum(albumName: string) {
        const id = `album-${albumName}`;
        this.created.push(albumName);
        return id;
    }
    async addToAlbum(albumId: string, ids: string[]) {
        this.adds.push({ albumId, ids });
    }
}

const dest = (over: Partial<ImmichDestination> = {}): ImmichDestination => ({
    kind: 'immich',
    baseUrl: 'https://immich.test',
    apiKey: 'k',
    recreateAlbums: true,
    syncFavorites: true,
    ...over,
});

const asset = (recordName: string, isFavorite = false) => ({ recordName, filename: `${recordName}.HEIC`, isFavorite });
const bytes = new Uint8Array([1]);

describe('ImmichUploader', () => {
    it('maps a favorite onto the upload when syncFavorites is on', async () => {
        const client = new FakeClient();
        const uploader = new ImmichUploader(client as unknown as ImmichClient, dest());
        await uploader.backup(asset('r1', true), bytes, 'image/heic');
        expect(client.uploads[0]!.isFavorite).toBe(true);
        expect(client.uploads[0]!.deviceAssetId).toBe('r1');
    });

    it('never marks favorites when syncFavorites is off', async () => {
        const client = new FakeClient();
        const uploader = new ImmichUploader(client as unknown as ImmichClient, dest({ syncFavorites: false }));
        await uploader.backup(asset('r1', true), bytes, 'image/heic');
        expect(client.uploads[0]!.isFavorite).toBe(false);
    });

    it('creates each album once and adds every member to it', async () => {
        const client = new FakeClient();
        const uploader = new ImmichUploader(client as unknown as ImmichClient, dest());

        const r1 = await uploader.backup(asset('r1'), bytes, undefined, 'Vacation');
        const r2 = await uploader.backup(asset('r2'), bytes, undefined, 'Vacation');

        expect(client.created).toEqual(['Vacation']); // created once, cached for r2
        expect(client.adds).toEqual([
            { albumId: 'album-Vacation', ids: ['id-r1'] },
            { albumId: 'album-Vacation', ids: ['id-r2'] },
        ]);
        expect([r1.id, r2.id]).toEqual(['id-r1', 'id-r2']);
    });

    it('reuses an existing Immich album with the same name', async () => {
        const client = new FakeClient();
        client.existingAlbums = [{ id: 'server-album', albumName: 'Trips' }];
        const uploader = new ImmichUploader(client as unknown as ImmichClient, dest());

        await uploader.backup(asset('r1'), bytes, undefined, 'Trips');

        expect(client.created).toEqual([]); // matched the existing album, no create
        expect(client.adds).toEqual([{ albumId: 'server-album', ids: ['id-r1'] }]);
    });

    it('does not touch albums when recreateAlbums is off', async () => {
        const client = new FakeClient();
        const uploader = new ImmichUploader(client as unknown as ImmichClient, dest({ recreateAlbums: false }));
        await uploader.backup(asset('r1'), bytes, undefined, 'Vacation');
        expect(client.listCalls).toBe(0);
        expect(client.created).toEqual([]);
        expect(client.adds).toEqual([]);
    });
});
