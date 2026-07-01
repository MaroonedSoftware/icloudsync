import type { StoredCookie } from './http/cookies.js';
import type { SessionStore } from './session/session.store.js';

/** Account metadata returned by `accountLogin` under `dsInfo`. */
export interface DsInfo {
    /** Apple "directory services" id — the per-account identifier. */
    dsid: string | number;
    fullName?: string;
    appleId?: string;
    /** Two-step (1) vs two-factor (2) authentication version. */
    hsaVersion?: number;
    [key: string]: unknown;
}

/** A single entry in the discovered `webservices` map. */
export interface WebserviceEntry {
    url: string;
    status?: string;
    /** True when the service requires a PCS consent grant (ADP accounts). */
    pcsRequired?: boolean;
}

/** Map of service name (`ckdatabasews`, `drivews`, `findme`, …) to its endpoint. */
export type WebservicesMap = Record<string, WebserviceEntry>;

/** The complete persisted session, serialized to {@link SessionStore}. */
export interface AuthSession {
    version: 1;
    accountName: string;
    /** Stable `auth-<uuid>` client id, generated once and reused. */
    clientId: string;
    /** `dsWebAuthToken` used for `accountLogin`. */
    sessionToken?: string;
    /** 2FA trust token; its presence lets future logins skip 2FA. */
    trustToken?: string;
    accountCountry?: string;
    /** Resolved account dsid (after session establishment). */
    dsid?: string;
    /** Discovered service endpoints (after session establishment). */
    webservices?: WebservicesMap;
    cookies: StoredCookie[];
}

export interface ClientConfig {
    /** Apple ID / iCloud email address. */
    accountName: string;
    /** Persistence backend; defaults to {@link FileSessionStore}. */
    sessionStore?: SessionStore;
    /** Override the generated `auth-<uuid>` client id. */
    clientId?: string;
    /** Override the `fetch` implementation (proxies, tests). */
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    /** Log auth-flow diagnostics to stderr. */
    debug?: boolean;
}

/** Outcome of a {@link ICloudClient.login} call. */
export type LoginResult = { state: 'authenticated' } | { state: 'mfaRequired' };

/** A trusted phone number that can receive an SMS 2FA code. */
export interface TwoFactorPhone {
    id: number;
    number?: string;
}

/** 2FA delivery options after a `mfaRequired` login. */
export interface TwoFactorOptions {
    /** Trusted Apple devices that received a push code (read it off a device). */
    trustedDeviceCount: number;
    /** Trusted phone numbers that can be sent an SMS code. */
    phoneNumbers: TwoFactorPhone[];
}
