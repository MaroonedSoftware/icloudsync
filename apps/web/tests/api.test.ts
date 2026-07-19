import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, downloadUrl, isVideo, previewResolution, thumbnailResolution, type Photo, type PhotoResource } from '../src/api';

/** Build a minimal `Response`-like stub matching the fields `request()` reads. */
function fakeResponse(opts: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    json?: () => Promise<unknown>;
}): Response {
    const status = opts.status ?? 200;
    return {
        ok: opts.ok ?? (status >= 200 && status < 300),
        status,
        statusText: opts.statusText ?? '',
        json: opts.json ?? (async () => ({})),
    } as Response;
}

function stubFetch(res: Response) {
    // Type the args so `spy.mock.calls[n]` is a `[url, init?]` tuple, not `[]`.
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => res);
    vi.stubGlobal('fetch', spy);
    return spy;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('request (via api client)', () => {
    it('parses a JSON body on success', async () => {
        stubFetch(fakeResponse({ json: async () => ({ accounts: [{ account: 'a@b.com', authenticated: true }] }) }));
        await expect(api.accounts()).resolves.toEqual([{ account: 'a@b.com', authenticated: true }]);
    });

    it('sends JSON content-type and merges caller headers', async () => {
        const spy = stubFetch(fakeResponse({ json: async () => ({ schedule: '0 * * * *', accounts: [] }) }));
        await api.overview();
        const [, init] = spy.mock.calls[0]!;
        expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/json' });
    });

    it('returns undefined for a 204 No Content', async () => {
        stubFetch(fakeResponse({ status: 204, json: async () => ({ state: 'loggedOut' }) }));
        await expect(api.logout('a@b.com')).resolves.toBeUndefined();
    });

    it('throws an ApiError carrying status, reason, and message from a JSON error body', async () => {
        stubFetch(
            fakeResponse({
                ok: false,
                status: 422,
                json: async () => ({ message: 'Bad code', details: { reason: 'mfa_invalid' } }),
            }),
        );
        const err = await api.submitDeviceCode('a@b.com', '000000').catch(e => e);
        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(422);
        expect(err.reason).toBe('mfa_invalid');
        expect(err.message).toBe('422 Bad code (mfa_invalid)');
    });

    it('falls back to statusText when a JSON error body omits message and reason', async () => {
        stubFetch(
            fakeResponse({
                ok: false,
                status: 404,
                statusText: 'Not Found',
                json: async () => ({}),
            }),
        );
        const err = (await api.stats('a@b.com').catch(e => e)) as ApiError;
        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(404);
        expect(err.reason).toBeUndefined();
        expect(err.message).toBe('404 Not Found');
    });

    it('falls back to statusText when the error body is not JSON', async () => {
        stubFetch(
            fakeResponse({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                json: async () => {
                    throw new SyntaxError('not json');
                },
            }),
        );
        const err = (await api.stats('a@b.com').catch(e => e)) as ApiError;
        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(500);
        expect(err.reason).toBeUndefined();
        expect(err.message).toBe('500 Internal Server Error');
    });
});

describe('api request shaping', () => {
    it('URL-encodes the account id (which contains @) in the path', async () => {
        const spy = stubFetch(fakeResponse({ status: 204 }));
        await api.triggerSync('user+tag@example.com');
        const [url, init] = spy.mock.calls[0]!;
        expect(url).toBe('/icloud/accounts/user%2Btag%40example.com/sync');
        expect((init as RequestInit).method).toBe('POST');
        expect((init as RequestInit).body).toBe('{}');
    });

    it('sends the force flag in the sync body for a full re-sync', async () => {
        const spy = stubFetch(fakeResponse({ status: 204 }));
        await api.triggerSync('a@b.com', { force: true });
        expect((spy.mock.calls[0]![1] as RequestInit).body).toBe('{"force":true}');
    });

    it('builds the photos query string only from provided params', async () => {
        const spy = stubFetch(fakeResponse({ json: async () => ({ photos: [], total: 0, limit: 0, offset: 0 }) }));
        await api.listPhotos('a@b.com', { limit: 50, offset: 100, favorite: true, order: 'asc' });
        expect(spy.mock.calls[0]![0]).toBe('/icloud/accounts/a%40b.com/photos?limit=50&offset=100&favorite=true&order=asc');
    });

    it('omits absent photo params from the query string', async () => {
        const spy = stubFetch(fakeResponse({ json: async () => ({ photos: [], total: 0, limit: 0, offset: 0 }) }));
        await api.listPhotos('a@b.com', {});
        expect(spy.mock.calls[0]![0]).toBe('/icloud/accounts/a%40b.com/photos?');
    });

    it('sends settings patches as a PATCH with a JSON body', async () => {
        const spy = stubFetch(fakeResponse({ json: async () => ({}) }));
        await api.updateSettings({ syncCron: '0 3 * * *' });
        const [url, init] = spy.mock.calls[0]!;
        expect(url).toBe('/icloud/settings');
        expect((init as RequestInit).method).toBe('PATCH');
        expect((init as RequestInit).body).toBe(JSON.stringify({ syncCron: '0 3 * * *' }));
    });
});

describe('thumbnailResolution', () => {
    const photoWith = (keys: string[]): Photo => ({
        recordName: 'r',
        masterRecordName: null,
        filename: null,
        assetDate: null,
        addedDate: null,
        isFavorite: false,
        isHidden: false,
        isDeleted: false,
        resources: Object.fromEntries(keys.map(k => [k, { key: k, downloadURL: '' } as PhotoResource])),
        syncedAt: '',
    });

    it('returns undefined when there are no resources', () => {
        expect(thumbnailResolution(photoWith([]))).toBeUndefined();
    });

    it('prefers the smallest rendition in preference order', () => {
        expect(thumbnailResolution(photoWith(['resOriginalRes', 'resJPEGThumb', 'resJPEGMedRes']))).toBe('resJPEGThumb');
        expect(thumbnailResolution(photoWith(['resOriginalRes', 'resJPEGMedRes']))).toBe('resJPEGMedRes');
    });

    it('falls back to the first available key when none are in the preference list', () => {
        expect(thumbnailResolution(photoWith(['resWeirdCustom']))).toBe('resWeirdCustom');
    });
});

describe('previewResolution', () => {
    const photoWith = (keys: string[]): Photo => ({
        recordName: 'r',
        masterRecordName: null,
        filename: null,
        assetDate: null,
        addedDate: null,
        isFavorite: false,
        isHidden: false,
        isDeleted: false,
        resources: Object.fromEntries(keys.map(k => [k, { key: k, downloadURL: '' } as PhotoResource])),
        syncedAt: '',
    });

    it('prefers the largest viewable JPEG, never the original', () => {
        expect(previewResolution(photoWith(['resOriginalRes', 'resJPEGThumb', 'resJPEGMedRes', 'resJPEGFullRes']))).toBe('resJPEGFullRes');
        expect(previewResolution(photoWith(['resOriginalRes', 'resJPEGThumb', 'resJPEGMedRes']))).toBe('resJPEGMedRes');
    });

    it('falls back to the grid thumbnail when no preview-grade rendition exists', () => {
        expect(previewResolution(photoWith(['resWeirdCustom']))).toBe('resWeirdCustom');
        expect(previewResolution(photoWith([]))).toBeUndefined();
    });

    it('detects videos by their video renditions', () => {
        expect(isVideo(photoWith(['resVidMedRes', 'resJPEGThumb']))).toBe(true);
        expect(isVideo(photoWith(['resOriginalVidComplRes']))).toBe(true);
        expect(isVideo(photoWith(['resJPEGThumb', 'resJPEGFullRes', 'resOriginalRes']))).toBe(false);
    });
});

describe('downloadUrl', () => {
    it('builds an encoded same-origin download path', () => {
        expect(downloadUrl('a@b.com', 'REC/1', 'resJPEGThumb')).toBe(
            '/icloud/accounts/a%40b.com/photos/REC%2F1/download?resolution=resJPEGThumb',
        );
    });
});
