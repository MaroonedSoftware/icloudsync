/**
 * A minimal client for the Immich REST API — just the surface the sync job needs
 * to push an iCloud library into Immich: upload an asset, and reconcile albums.
 *
 * Immich owns storage and organization once an asset lands: it dedupes uploads by
 * checksum (a re-upload of the same bytes returns `duplicate` with the existing
 * id, so re-syncs are cheap), derives the timeline/GPS from the file's own EXIF,
 * and exposes favorites + albums as first-class concepts. That's why the Immich
 * destination has no layout/naming knobs — this client maps iCloud's notions
 * (favorite, album membership) onto Immich's and lets the server do the rest.
 *
 * Auth is a static API key sent as `x-api-key`. All calls throw
 * {@link ImmichError} on a non-2xx response so the job can log and move on.
 */

/** Error thrown when an Immich API call returns a non-2xx status. */
export class ImmichError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'ImmichError';
    }
}

/** Result of an upload: the asset's Immich id and whether it already existed. */
export interface ImmichUploadResult {
    id: string;
    /** True when Immich recognized the bytes as an existing asset (checksum dedupe). */
    duplicate: boolean;
}

/** The `fetch` signature this client depends on (injectable so tests need no network). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What the client needs to describe an asset it is uploading. */
export interface ImmichAsset {
    /** A stable per-asset id (the iCloud record name) — Immich's `deviceAssetId`. */
    deviceAssetId: string;
    filename: string;
    bytes: Uint8Array;
    contentType?: string;
    /** Capture date (epoch ms); falls back to now when unknown. */
    assetDate?: number;
    isFavorite: boolean;
}

export class ImmichClient {
    private readonly base: string;

    /**
     * @param baseUrl   Immich server base URL (a trailing `/` or `/api` is tolerated).
     * @param apiKey    An API key with asset-upload + album permissions.
     * @param deviceId  The `deviceId` reported on uploads (groups this backup's assets).
     * @param fetchImpl Injectable `fetch` (defaults to the global) for testing.
     */
    constructor(
        baseUrl: string,
        private readonly apiKey: string,
        private readonly deviceId = 'icloudsync',
        private readonly fetchImpl: FetchLike = fetch,
    ) {
        // Normalize to `<origin>/api`: accept `https://host`, `https://host/`, or `https://host/api`.
        const trimmed = baseUrl.trim().replace(/\/+$/, '');
        this.base = trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
    }

    private headers(extra?: Record<string, string>): Record<string, string> {
        return { 'x-api-key': this.apiKey, Accept: 'application/json', ...extra };
    }

    private async json<T>(res: Response): Promise<T> {
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new ImmichError(res.status, `Immich ${res.status}: ${body.slice(0, 200) || res.statusText}`);
        }
        return (await res.json()) as T;
    }

    /**
     * Upload one asset. Immich dedupes by checksum: re-uploading identical bytes
     * returns the existing id with `duplicate: true`, so this is safe to call on
     * every sync pass. Favorite state is set on the asset when `isFavorite`.
     */
    async upload(asset: ImmichAsset): Promise<ImmichUploadResult> {
        const created = asset.assetDate != null && !Number.isNaN(asset.assetDate) ? new Date(asset.assetDate) : new Date(0);
        const iso = created.getTime() > 0 ? created.toISOString() : new Date().toISOString();

        const form = new FormData();
        form.append('deviceAssetId', asset.deviceAssetId);
        form.append('deviceId', this.deviceId);
        form.append('fileCreatedAt', iso);
        form.append('fileModifiedAt', iso);
        form.append('isFavorite', String(asset.isFavorite));
        // Cast: a Uint8Array is a valid BlobPart at runtime; the DOM lib's `BlobPart`
        // is narrowed to `ArrayBuffer`-backed views, which our bytes may not be typed as.
        const blob = new Blob([asset.bytes as BlobPart], { type: asset.contentType ?? 'application/octet-stream' });
        form.append('assetData', blob, asset.filename);

        const res = await this.fetchImpl(`${this.base}/assets`, { method: 'POST', headers: this.headers(), body: form });
        const body = await this.json<{ id: string; status: string }>(res);
        return { id: body.id, duplicate: body.status === 'duplicate' };
    }

    /** All albums on the server (id + name), for matching an existing album by name. */
    async listAlbums(): Promise<{ id: string; albumName: string }[]> {
        const res = await this.fetchImpl(`${this.base}/albums`, { headers: this.headers() });
        return this.json<{ id: string; albumName: string }[]>(res);
    }

    /** Create an album with the given name and initial assets; returns its id. */
    async createAlbum(albumName: string, assetIds: string[] = []): Promise<string> {
        const res = await this.fetchImpl(`${this.base}/albums`, {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ albumName, assetIds }),
        });
        const body = await this.json<{ id: string }>(res);
        return body.id;
    }

    /** Add assets to an existing album. Immich ignores assets already present. */
    async addToAlbum(albumId: string, assetIds: string[]): Promise<void> {
        if (assetIds.length === 0) return;
        const res = await this.fetchImpl(`${this.base}/albums/${encodeURIComponent(albumId)}/assets`, {
            method: 'PUT',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ ids: assetIds }),
        });
        // 200 with a per-asset result array; a non-2xx is a real failure.
        await this.json<unknown>(res);
    }

    /** A lightweight connectivity/auth check (`GET /api/server/ping` → `{ res: 'pong' }`). */
    async ping(): Promise<boolean> {
        const res = await this.fetchImpl(`${this.base}/server/ping`, { headers: this.headers() });
        if (!res.ok) return false;
        const body = (await res.json().catch(() => ({}))) as { res?: string };
        return body.res === 'pong';
    }
}
