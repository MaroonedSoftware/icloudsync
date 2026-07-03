import type { ImmichDestination } from './photo.destination.js';
import { ImmichClient, type ImmichUploadResult } from './immich.client.js';

/** The subset of an asset the uploader needs. */
export interface UploadableAsset {
    /** iCloud record name — used as Immich's stable `deviceAssetId`. */
    recordName: string;
    filename?: string;
    assetDate?: number;
    isFavorite: boolean;
}

/**
 * Per-sync-run wrapper around {@link ImmichClient} that also reconciles albums.
 * It caches each album's Immich id (resolving an existing album by name, else
 * creating it) so a library's worth of uploads issues at most one create per
 * album, and adds each asset to its album as it lands. Constructed fresh for the
 * account being synced (it holds that account's Immich connection + album cache).
 */
export class ImmichUploader {
    /** album name → its Immich album id (a shared promise so concurrent callers don't double-create). */
    private readonly albumIds = new Map<string, Promise<string>>();

    constructor(
        private readonly client: ImmichClient,
        private readonly dest: ImmichDestination,
    ) {}

    /** Build an uploader for a destination, wiring a real {@link ImmichClient} unless one is injected (tests). */
    static create(dest: ImmichDestination, deviceId: string, client?: ImmichClient): ImmichUploader {
        return new ImmichUploader(client ?? new ImmichClient(dest.baseUrl, dest.apiKey, deviceId), dest);
    }

    /**
     * Upload one asset and, when album recreation is on and the asset belongs to
     * an album, add it there. Returns the Immich asset id (recorded as the backup
     * key so re-syncs skip it) and whether Immich already had the bytes.
     */
    async backup(asset: UploadableAsset, bytes: Uint8Array, contentType: string | undefined, albumName?: string): Promise<ImmichUploadResult> {
        const result = await this.client.upload({
            deviceAssetId: asset.recordName,
            filename: asset.filename ?? asset.recordName,
            bytes,
            contentType,
            assetDate: asset.assetDate,
            isFavorite: this.dest.syncFavorites && asset.isFavorite,
        });
        if (this.dest.recreateAlbums && albumName) {
            const albumId = await this.albumId(albumName);
            await this.client.addToAlbum(albumId, [result.id]);
        }
        return result;
    }

    /** Resolve (and cache) an album name to its Immich id, creating the album if absent. */
    private albumId(name: string): Promise<string> {
        let pending = this.albumIds.get(name);
        if (!pending) {
            pending = this.resolveAlbum(name);
            this.albumIds.set(name, pending);
        }
        return pending;
    }

    private async resolveAlbum(name: string): Promise<string> {
        const existing = (await this.client.listAlbums()).find(a => a.albumName === name);
        return existing ? existing.id : this.client.createAlbum(name);
    }
}
