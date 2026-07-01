// Typed client for the @icloudsync/api HTTP surface. The SPA is served by the
// API (same-origin in prod; Vite proxies /icloud → API in dev), so all requests
// are relative and replay the browser session automatically.

export interface AccountStatus {
    account: string;
    authenticated: boolean;
}

export type LoginState = 'authenticated' | 'mfaRequired' | 'loggedOut';
export interface LoginResult {
    state: LoginState;
}

export interface TwoFactorPhone {
    id: number;
    number: string;
}
export interface TwoFactorOptions {
    trustedDeviceCount: number;
    phoneNumbers: TwoFactorPhone[];
}

export interface PhotoResource {
    key: string;
    downloadURL: string;
    size?: number;
    width?: number;
    height?: number;
    fileType?: string;
}

export interface Photo {
    recordName: string;
    masterRecordName: string | null;
    filename: string | null;
    assetDate: number | null;
    addedDate: number | null;
    isFavorite: boolean;
    isHidden: boolean;
    isDeleted: boolean;
    resources: Record<string, PhotoResource>;
    syncedAt: string;
}

export interface PhotosPage {
    photos: Photo[];
    total: number;
    limit: number;
    offset: number;
}

export type PhotoLayout = 'flat' | 'date' | 'album';

export type NotificationChannel = 'none' | 'webhook' | 'email';

export interface EmailSettings {
    host: string;
    port: number;
    secure: boolean;
    username?: string;
    password?: string;
    from: string;
    to: string;
}

export interface NotificationSettings {
    /** Active delivery channel; `none` disables notifications. */
    channel: NotificationChannel;
    /** Minimum hours between re-notifications for the same still-broken account. */
    throttleHours: number;
    /** Target URL for the `webhook` channel. */
    webhookUrl?: string;
    /** SMTP settings for the `email` channel. */
    email?: EmailSettings;
}

export interface AppSettings {
    photosLayout: PhotoLayout;
    syncCron: string;
    notifications: NotificationSettings;
}

export interface Stats {
    account: string;
    /** The sync cron expression. */
    schedule: string;
    /** Whether a sync is currently running for this account. */
    running: boolean;
    total: number;
    favorites: number;
    /** Assets whose original bytes are archived to storage. */
    backedUp: number;
    /** Total bytes archived to storage. */
    backedUpBytes: number;
    newestAssetDate: number | null;
    oldestAssetDate: number | null;
    lastSyncedAt: string | null;
}

/** One account's row in the admin overview: live auth state + synced-library stats. */
export interface AccountOverview {
    account: string;
    authenticated: boolean;
    total: number;
    favorites: number;
    backedUp: number;
    backedUpBytes: number;
    newestAssetDate: number | null;
    oldestAssetDate: number | null;
    lastSyncedAt: string | null;
}

/** The all-accounts admin overview: the global schedule plus each account's status + stats. */
export interface Overview {
    schedule: string;
    accounts: AccountOverview[];
}

export interface ListPhotosParams {
    limit?: number;
    offset?: number;
    favorite?: boolean;
    order?: 'asc' | 'desc';
}

/** An error carrying the API's machine-readable `reason` (see error-mapping on the server). */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly reason: string | undefined,
        message: string,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    if (!res.ok) {
        let reason: string | undefined;
        let detail = res.statusText;
        try {
            const body = (await res.json()) as { details?: { reason?: string }; message?: string };
            reason = body.details?.reason;
            detail = body.message ?? detail;
        } catch {
            // non-JSON error body — keep the status text
        }
        throw new ApiError(res.status, reason, `${res.status} ${detail}${reason ? ` (${reason})` : ''}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
}

/** Base path for an account's routes; the Apple ID is URL-encoded (it contains `@`). */
const accountPath = (account: string): string => `/icloud/accounts/${encodeURIComponent(account)}`;

export const api = {
    /** The registered accounts and whether each has a usable session loaded. */
    accounts: async () => (await request<{ accounts: AccountStatus[] }>('/icloud/accounts')).accounts,
    /** All-accounts admin overview (status + stats + the global schedule). */
    overview: () => request<Overview>('/icloud/overview'),
    /** Enqueue a sync of every registered account. */
    syncAll: () => request<{ queued: boolean; job: string }>('/icloud/sync', { method: 'POST', body: '{}' }),
    login: (account: string, password: string) =>
        request<LoginResult>(`${accountPath(account)}/login`, { method: 'POST', body: JSON.stringify({ password }) }),
    submitDeviceCode: (account: string, code: string) =>
        request<LoginResult>(`${accountPath(account)}/2fa`, { method: 'POST', body: JSON.stringify({ code }) }),
    /** Ask Apple to push a security code to the account's trusted devices. */
    requestDeviceCode: (account: string) => request<{ requested: boolean }>(`${accountPath(account)}/2fa/device`, { method: 'POST', body: '{}' }),
    twoFactorOptions: (account: string) => request<TwoFactorOptions>(`${accountPath(account)}/2fa/options`),
    requestPhoneCode: (account: string, phoneId: number) =>
        request<{ requested: boolean }>(`${accountPath(account)}/2fa/phone`, { method: 'POST', body: JSON.stringify({ phoneId }) }),
    verifyPhoneCode: (account: string, phoneId: number, code: string) =>
        request<LoginResult>(`${accountPath(account)}/2fa/phone/verify`, { method: 'POST', body: JSON.stringify({ phoneId, code }) }),
    logout: (account: string) => request<LoginResult>(`${accountPath(account)}/logout`, { method: 'POST' }),
    /** Forget the session and unregister the account entirely. */
    removeAccount: (account: string) => request<{ state: string }>(accountPath(account), { method: 'DELETE' }),
    triggerSync: (account: string) => request<{ queued: boolean; job: string }>(`${accountPath(account)}/sync`, { method: 'POST', body: '{}' }),
    /** Request cancellation of an account's running sync. `cancelled` is whether a run was actively aborted. */
    cancelSync: (account: string) => request<{ cancelled: boolean }>(`${accountPath(account)}/sync/cancel`, { method: 'POST' }),
    stats: (account: string) => request<Stats>(`${accountPath(account)}/stats`),
    settings: () => request<AppSettings>('/icloud/settings'),
    updateSettings: (patch: Partial<Pick<AppSettings, 'photosLayout' | 'syncCron' | 'notifications'>>) =>
        request<AppSettings>('/icloud/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
    /** Send a test notification over the configured channel; rejects (422) with the error if it fails. */
    testNotification: () => request<{ sent: boolean }>('/icloud/notifications/test', { method: 'POST', body: '{}' }),
    listPhotos: (account: string, params: ListPhotosParams = {}) => {
        const q = new URLSearchParams();
        if (params.limit != null) q.set('limit', String(params.limit));
        if (params.offset != null) q.set('offset', String(params.offset));
        if (params.favorite != null) q.set('favorite', String(params.favorite));
        if (params.order) q.set('order', params.order);
        return request<PhotosPage>(`${accountPath(account)}/photos?${q.toString()}`);
    },
};

/** Resolution keys in ascending size — used to pick the lightest available thumbnail. */
const THUMB_PREFERENCE = ['resJPEGThumb', 'resJPEGMedRes', 'resVidMedRes', 'resJPEGFullRes', 'resOriginalRes', 'resOriginalVidComplRes'];

/** Pick the smallest sensible rendition key present on a photo, for grid thumbnails. */
export function thumbnailResolution(photo: Photo): string | undefined {
    const keys = Object.keys(photo.resources);
    if (keys.length === 0) return undefined;
    return THUMB_PREFERENCE.find(k => k in photo.resources) ?? keys[0];
}

/** Same-origin download URL for an account's rendition, served by the API's download proxy. */
export function downloadUrl(account: string, recordName: string, resolution: string): string {
    return `${accountPath(account)}/photos/${encodeURIComponent(recordName)}/download?resolution=${encodeURIComponent(resolution)}`;
}
