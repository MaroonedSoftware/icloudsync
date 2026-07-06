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

import { parseRetryAfter } from '@icloudsync/icloud';

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

/**
 * HTTP statuses worth retrying: a throttle (429) or a transient
 * overload/gateway error from Immich or a reverse proxy in front of it. A 4xx
 * like 401 (bad key) or 404 (wrong URL) is a permanent misconfiguration and is
 * never retried.
 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Tunables for the Immich client's retry + per-request timeout behaviour. */
export interface ImmichRetryOptions {
    /** Retry attempts made after the first failure before giving up. Set `0` to fail fast. Default `3`. */
    maxRetries?: number;
    /** Backoff for the first retry when the server sends no `Retry-After`; doubles each attempt. Default `1000`ms. */
    baseDelayMs?: number;
    /** Upper bound on any single wait, including a server-supplied `Retry-After`. Default `60000`ms. */
    maxDelayMs?: number;
    /**
     * Per-request timeout so a wedged Immich (connection accepted, no response)
     * can't stall the whole serial sync. Generous by default because it also
     * bounds a large-video upload; raise it for big libraries on slow links.
     * Default `600000`ms (10 min).
     */
    timeoutMs?: number;
    /** Sleep implementation; injectable so tests need not wait on real timers. */
    sleep?: (ms: number) => Promise<void>;
}

type ResolvedRetry = Required<ImmichRetryOptions>;

const DEFAULT_RETRY: ResolvedRetry = {
    maxRetries: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    timeoutMs: 600_000,
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
};

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
    private readonly retry: ResolvedRetry;

    /**
     * @param baseUrl   Immich server base URL (a trailing `/` or `/api` is tolerated).
     * @param apiKey    An API key with asset-upload + album permissions.
     * @param deviceId  The `deviceId` reported on uploads (groups this backup's assets).
     * @param fetchImpl Injectable `fetch` (defaults to the global) for testing.
     * @param retry     Retry + timeout tunables (see {@link ImmichRetryOptions}).
     */
    constructor(
        baseUrl: string,
        private readonly apiKey: string,
        private readonly deviceId = 'icloudsync',
        private readonly fetchImpl: FetchLike = fetch,
        retry: ImmichRetryOptions = {},
    ) {
        // Normalize to `<origin>/api`: accept `https://host`, `https://host/`, or `https://host/api`.
        const trimmed = baseUrl.trim().replace(/\/+$/, '');
        this.base = trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
        this.retry = { ...DEFAULT_RETRY, ...retry };
    }

    private headers(extra?: Record<string, string>): Record<string, string> {
        return { 'x-api-key': this.apiKey, Accept: 'application/json', ...extra };
    }

    /**
     * Issue a request, retrying transient failures with backoff so we ease off
     * when Immich pushes back (429/503) instead of firing the next upload
     * immediately, and bounding each attempt with a timeout so a wedged server
     * can't stall the serial sync. `build` is called fresh per attempt so the
     * request body (e.g. an upload's multipart form) is never a consumed stream.
     * A retryable status that survives every attempt is returned as-is so the
     * caller's {@link json} turns it into an {@link ImmichError}; a network
     * failure or timeout that survives is thrown as an {@link ImmichError}.
     */
    private async dispatch(url: string, build: () => RequestInit): Promise<Response> {
        for (let attempt = 0; ; attempt++) {
            let response: Response;
            try {
                response = await this.fetchImpl(url, { ...build(), signal: AbortSignal.timeout(this.retry.timeoutMs) });
            } catch (error) {
                // fetch rejected before any response: DNS/refused/TLS, or our own timeout aborted it.
                if (attempt >= this.retry.maxRetries) {
                    throw new ImmichError(0, `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
                }
                await this.retry.sleep(Math.min(this.retry.baseDelayMs * 2 ** attempt, this.retry.maxDelayMs));
                continue;
            }

            if (!RETRYABLE_STATUS.has(response.status) || attempt >= this.retry.maxRetries) return response;

            const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
            const backoff = retryAfterMs ?? this.retry.baseDelayMs * 2 ** attempt;
            await this.retry.sleep(Math.min(backoff, this.retry.maxDelayMs));
        }
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

        const res = await this.dispatch(`${this.base}/assets`, () => {
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
            return { method: 'POST', headers: this.headers(), body: form };
        });
        const body = await this.json<{ id: string; status: string }>(res);
        return { id: body.id, duplicate: body.status === 'duplicate' };
    }

    /** All albums on the server (id + name), for matching an existing album by name. */
    async listAlbums(): Promise<{ id: string; albumName: string }[]> {
        const res = await this.dispatch(`${this.base}/albums`, () => ({ headers: this.headers() }));
        return this.json<{ id: string; albumName: string }[]>(res);
    }

    /** Create an album with the given name and initial assets; returns its id. */
    async createAlbum(albumName: string, assetIds: string[] = []): Promise<string> {
        const res = await this.dispatch(`${this.base}/albums`, () => ({
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ albumName, assetIds }),
        }));
        const body = await this.json<{ id: string }>(res);
        return body.id;
    }

    /** Add assets to an existing album. Immich ignores assets already present. */
    async addToAlbum(albumId: string, assetIds: string[]): Promise<void> {
        if (assetIds.length === 0) return;
        const res = await this.dispatch(`${this.base}/albums/${encodeURIComponent(albumId)}/assets`, () => ({
            method: 'PUT',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ ids: assetIds }),
        }));
        // 200 with a per-asset result array; a non-2xx is a real failure.
        await this.json<unknown>(res);
    }

    /** A lightweight connectivity/auth check (`GET /api/server/ping` → `{ res: 'pong' }`). */
    async ping(): Promise<boolean> {
        const res = await this.dispatch(`${this.base}/server/ping`, () => ({ headers: this.headers() }));
        if (!res.ok) return false;
        const body = (await res.json().catch(() => ({}))) as { res?: string };
        return body.res === 'pong';
    }

    /**
     * Verify the connection end to end for the settings UI: the server answers a
     * ping (URL is right and reachable), then `GET /api/users/me` succeeds (the API
     * key is accepted). Resolves on success; throws {@link ImmichError} with a
     * user-facing message otherwise — a bad host, a wrong port, or a rejected key
     * each map to a distinct reason.
     */
    async verify(): Promise<void> {
        let reachable: boolean;
        try {
            reachable = await this.ping();
        } catch (error) {
            // fetch rejects (DNS failure, refused connection, TLS error, …) before any response.
            throw new ImmichError(0, `could not reach the server: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!reachable) throw new ImmichError(0, 'server did not respond to a ping — check the URL');
        const res = await this.dispatch(`${this.base}/users/me`, () => ({ headers: this.headers() }));
        if (!res.ok) {
            throw new ImmichError(res.status, res.status === 401 || res.status === 403 ? 'the API key was rejected' : `server returned ${res.status}`);
        }
    }
}
