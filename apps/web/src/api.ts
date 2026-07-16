// Typed client for the @icloudsync/api HTTP surface. The SPA is served by the
// API (same-origin in prod; Vite proxies /icloud → API in dev), so all requests
// are relative and replay the browser session automatically.

export interface AccountStatus {
    /** The account's UUID (its internal identity, used in every account-scoped call). */
    id: string;
    /** The Apple ID email (for display). */
    account: string;
    authenticated: boolean;
}

export type LoginState = 'authenticated' | 'mfaRequired' | 'loggedOut';
export interface LoginResult {
    state: LoginState;
}

/** Result of creating/beginning login for an account: its id plus the login state. */
export interface CreateAccountResult extends LoginResult {
    /** The (possibly newly created) account's UUID. */
    id: string;
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

export type PhotoNaming = 'clean' | 'datetime' | 'hash';

/** A filesystem organization preset (see the server's `photo.destination`). */
export type FilesystemPreset = 'immich' | 'browsable';

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

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LoggingSettings {
    /** Whether the rotating file log is written. `false` stops file writes (console output is unaffected). */
    enabled: boolean;
    /** Lowest level to persist. */
    level: LogLevel;
    /** Roll the active file over once it passes this many megabytes. */
    maxSizeMb: number;
    /** Total files to keep, including the active one. */
    maxFiles: number;
}

export interface AppSettings {
    syncCron: string;
    notifications: NotificationSettings;
    logging: LoggingSettings;
}

/**
 * An account's on-disk photo organization: its overrides (`null` = inherit the
 * built-in default) plus the `defaults` those null fields fall back to.
 */
export interface AccountSettings {
    /** Filesystem preset override, or `null` to inherit the default. */
    photosPreset: FilesystemPreset | null;
    photosLayout: PhotoLayout | null;
    photosNaming: PhotoNaming | null;
    /** Custom photo-archive path prefix, or `null` to use the default (the Apple ID's local part). */
    archivePrefix: string | null;
    /** The prefix an unset `archivePrefix` defaults to (the Apple ID's local part), or `null` if the account is gone. */
    defaultPrefix: string | null;
    /** True while a prefix change's file move is still queued or running. */
    relocating: boolean;
    /** The last move's failure summary, or `null` if it succeeded / none ran. */
    relocationError: string | null;
    defaults: { photosPreset: FilesystemPreset; photosLayout: PhotoLayout; photosNaming: PhotoNaming };
}

export interface Stats {
    /** The account's UUID. */
    id: string;
    /** The sync cron expression. */
    schedule: string;
    /** Whether a sync is currently running for this account. */
    running: boolean;
    /** The iCloud library's asset count, pulled at the last sync's start, or `null` if no sync has run. Used as the backup-progress denominator. */
    libraryTotal: number | null;
    /** Whether the server serves thumbnails (disabled when the thumbnail-cache budget is 0). */
    thumbnails: boolean;
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
    /** The account's UUID. */
    id: string;
    /** The Apple ID email (for display). */
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

/** Base path for an account's routes, keyed by its UUID id. */
const accountPath = (id: string): string => `/icloud/accounts/${encodeURIComponent(id)}`;

export const api = {
    /** The registered accounts and whether each has a usable session loaded. */
    accounts: async () => (await request<{ accounts: AccountStatus[] }>('/icloud/accounts')).accounts,
    /** All-accounts admin overview (status + stats + the global schedule). */
    overview: () => request<Overview>('/icloud/overview'),
    /** Enqueue a sync of every registered account. */
    syncAll: () => request<{ queued: boolean; job: string }>('/icloud/sync', { method: 'POST', body: '{}' }),
    /** Register (or reuse) an account by Apple ID and begin login; returns its id + login state. */
    createAccount: (accountName: string, password: string) =>
        request<CreateAccountResult>('/icloud/accounts', { method: 'POST', body: JSON.stringify({ accountName, password }) }),
    submitDeviceCode: (id: string, code: string) =>
        request<LoginResult>(`${accountPath(id)}/2fa`, { method: 'POST', body: JSON.stringify({ code }) }),
    /** Ask Apple to push a security code to the account's trusted devices. */
    requestDeviceCode: (id: string) => request<{ requested: boolean }>(`${accountPath(id)}/2fa/device`, { method: 'POST', body: '{}' }),
    twoFactorOptions: (id: string) => request<TwoFactorOptions>(`${accountPath(id)}/2fa/options`),
    requestPhoneCode: (id: string, phoneId: number) =>
        request<{ requested: boolean }>(`${accountPath(id)}/2fa/phone`, { method: 'POST', body: JSON.stringify({ phoneId }) }),
    verifyPhoneCode: (id: string, phoneId: number, code: string) =>
        request<LoginResult>(`${accountPath(id)}/2fa/phone/verify`, { method: 'POST', body: JSON.stringify({ phoneId, code }) }),
    logout: (id: string) => request<LoginResult>(`${accountPath(id)}/logout`, { method: 'POST' }),
    /** Forget the session and unregister the account entirely. */
    removeAccount: (id: string) => request<{ state: string }>(accountPath(id), { method: 'DELETE' }),
    /**
     * Enqueue a sync of one account. Pass `{ force: true }` for a full re-sync that
     * re-downloads and re-stores every asset, ignoring what's already backed up
     * (e.g. after switching the account's preset or layout).
     */
    triggerSync: (id: string, opts: { force?: boolean } = {}) =>
        request<{ queued: boolean; job: string }>(`${accountPath(id)}/sync`, { method: 'POST', body: JSON.stringify(opts) }),
    /** Request cancellation of an account's running sync. `cancelled` is whether a run was actively aborted. */
    cancelSync: (id: string) => request<{ cancelled: boolean }>(`${accountPath(id)}/sync/cancel`, { method: 'POST' }),
    stats: (id: string) => request<Stats>(`${accountPath(id)}/stats`),
    settings: () => request<AppSettings>('/icloud/settings'),
    updateSettings: (patch: Partial<Pick<AppSettings, 'syncCron' | 'notifications' | 'logging'>>) =>
        request<AppSettings>('/icloud/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
    accountSettings: (id: string) => request<AccountSettings>(`${accountPath(id)}/settings`),
    /** Patch an account's preset/layout/naming/prefix overrides; `null` (or `''` for the prefix) clears an override back to the default. */
    updateAccountSettings: (
        id: string,
        patch: {
            photosPreset?: FilesystemPreset | null;
            photosLayout?: PhotoLayout | null;
            photosNaming?: PhotoNaming | null;
            archivePrefix?: string | null;
        },
    ) => request<AccountSettings>(`${accountPath(id)}/settings`, { method: 'PATCH', body: JSON.stringify(patch) }),
    /** Resume a relocation that failed part-way (re-runs the recorded move). Returns the updated settings. */
    retryRelocation: (id: string) => request<AccountSettings>(`${accountPath(id)}/relocate/retry`, { method: 'POST', body: '{}' }),
    /** Send a test notification over the configured channel; rejects (422) with the error if it fails. */
    testNotification: () => request<{ sent: boolean }>('/icloud/notifications/test', { method: 'POST', body: '{}' }),
    listPhotos: (id: string, params: ListPhotosParams = {}) => {
        const q = new URLSearchParams();
        if (params.limit != null) q.set('limit', String(params.limit));
        if (params.offset != null) q.set('offset', String(params.offset));
        if (params.favorite != null) q.set('favorite', String(params.favorite));
        if (params.order) q.set('order', params.order);
        return request<PhotosPage>(`${accountPath(id)}/photos?${q.toString()}`);
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
export function downloadUrl(id: string, recordName: string, resolution: string): string {
    return `${accountPath(id)}/photos/${encodeURIComponent(recordName)}/download?resolution=${encodeURIComponent(resolution)}`;
}
