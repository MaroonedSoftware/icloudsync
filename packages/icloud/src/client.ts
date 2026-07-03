import { randomUUID } from 'node:crypto';
import { Authenticator, trustedPhoneNumbersOf } from './auth/authenticator.js';
import { establishSession } from './auth/session.js';
import { serviceBaseHeaders, USER_AGENT } from './constants.js';
import { AuthenticationError, ICloudError } from './errors.js';
import { HttpClient } from './http/client.js';
import { CookieJar } from './http/cookies.js';
import { PhotosService } from './services/photos.js';
import { FileSessionStore } from './session/file.session.store.js';
import type { HttpResponse } from './http/client.js';
import type { SessionStore } from './session/session.store.js';
import type { AuthSession, ClientConfig, LoginResult, TwoFactorOptions, WebservicesMap } from './types.js';

const SESSION_VERSION = 1 as const;

/**
 * High-level iCloud client. Owns the auth lifecycle (SRP login, 2FA, trust,
 * session establishment) and persists the resulting session via {@link SessionStore}
 * so subsequent runs rehydrate and skip 2FA while the trust token is valid.
 *
 * ```ts
 * const client = new ICloudClient({ accountName: 'me@icloud.com' });
 * const result = await client.login(password);
 * if (result.state === 'mfaRequired') await client.submitSecurityCode(code);
 * client.serviceUrl('ckdatabasews'); // -> base URL for the Photos/CloudKit service
 * ```
 */
export class ICloudClient {
    private readonly storage: SessionStore;
    private readonly accountName: string;
    private readonly fetchImpl: ClientConfig['fetch'];
    private readonly retry: ClientConfig['retry'];
    private readonly debug: boolean;
    private jar: CookieJar;
    private http: HttpClient;
    private auth: Authenticator;
    private session: AuthSession;
    private loaded = false;

    constructor(config: ClientConfig) {
        this.accountName = config.accountName;
        this.storage = config.sessionStore ?? new FileSessionStore();
        this.fetchImpl = config.fetch;
        this.retry = config.retry;
        this.debug = config.debug ?? false;
        this.session = {
            version: SESSION_VERSION,
            accountName: config.accountName,
            clientId: config.clientId ?? `auth-${randomUUID()}`,
            cookies: [],
        };
        this.jar = new CookieJar();
        this.http = this.newHttp();
        this.auth = new Authenticator(this.http, this.accountName, this.session.clientId, this.debug);
    }

    private newHttp(): HttpClient {
        return new HttpClient(this.jar, this.fetchImpl ?? fetch, this.retry);
    }

    private storageKey(): string {
        return `session-${this.accountName}.json`;
    }

    /** Rebuild the cookie jar / http client / authenticator from `this.session`. */
    private rebuild(): void {
        this.jar = CookieJar.fromJSON(this.session.cookies);
        this.http = this.newHttp();
        this.auth = new Authenticator(this.http, this.accountName, this.session.clientId, this.debug);
    }

    /** Load a persisted session if present. Returns whether it is authenticated. */
    async restore(): Promise<boolean> {
        if (this.loaded) return this.isAuthenticated;
        const raw = await this.storage.read(this.storageKey());
        if (raw) {
            try {
                const parsed = JSON.parse(new TextDecoder().decode(raw)) as AuthSession;
                if (parsed.version === SESSION_VERSION && parsed.accountName === this.accountName) {
                    this.session = parsed;
                    this.rebuild();
                }
            } catch {
                // Ignore a corrupt session file; fall back to a fresh login.
            }
        }
        this.loaded = true;
        return this.isAuthenticated;
    }

    /** Begin authentication. Resolves to `authenticated` or `mfaRequired`. */
    async login(password: string): Promise<LoginResult> {
        await this.restore();
        const trustTokens = this.session.trustToken ? [this.session.trustToken] : [];
        const outcome = await this.auth.signIn(password, trustTokens);

        if (outcome.mfaRequired) {
            await this.persist();
            return { state: 'mfaRequired' };
        }
        if (outcome.sessionToken) this.session.sessionToken = outcome.sessionToken;
        if (outcome.accountCountry) this.session.accountCountry = outcome.accountCountry;
        await this.finalize();
        return { state: 'authenticated' };
    }

    /**
     * Inspect the 2FA delivery options after a `mfaRequired` login: how many
     * trusted devices received a push code, and which trusted phone numbers can
     * receive an SMS.
     *
     * Note: `trustedDeviceCount` is a legacy HSA (two-step verification) field.
     * Modern two-factor accounts (HSA2) report `0` here even when the account has
     * many trusted devices — Apple only enumerates trusted phone numbers via this
     * endpoint. The 6-digit code is still pushed to every trusted device on the
     * 409, so callers must not gate the trusted-device flow on this count.
     */
    async getTwoFactorOptions(): Promise<TwoFactorOptions> {
        const state = await this.auth.getAuthState();
        return {
            trustedDeviceCount: state.trustedDeviceCount ?? 0,
            phoneNumbers: trustedPhoneNumbersOf(state).map(p => ({ id: p.id, number: p.numberWithDialCode })),
        };
    }

    /**
     * Ask Apple to push a security code to the account's trusted devices. Call
     * this when the user chooses the trusted-device path, since Apple does not
     * reliably auto-push the code on the sign-in 409. Safe to call again to resend.
     */
    requestDeviceCode(): Promise<void> {
        return this.auth.requestDeviceCode();
    }

    /** Complete a `mfaRequired` login with a code pushed to a trusted device. */
    async submitSecurityCode(code: string): Promise<LoginResult> {
        await this.auth.submitSecurityCode(code);
        return this.completeTwoFactor();
    }

    /** Request that an SMS security code be sent to a trusted phone number. */
    requestPhoneCode(phoneId: number): Promise<void> {
        return this.auth.requestPhoneCode(phoneId);
    }

    /** Complete a `mfaRequired` login with an SMS code sent to a phone number. */
    async submitPhoneCode(code: string, phoneId: number): Promise<LoginResult> {
        await this.auth.submitPhoneCode(code, phoneId);
        return this.completeTwoFactor();
    }

    /** Shared post-2FA step: exchange for a trust token and establish the session. */
    private async completeTwoFactor(): Promise<LoginResult> {
        const { trustToken, sessionToken } = await this.auth.trust();
        if (trustToken) this.session.trustToken = trustToken;
        if (sessionToken) this.session.sessionToken = sessionToken;
        await this.finalize();
        return { state: 'authenticated' };
    }

    private async finalize(): Promise<void> {
        if (!this.session.sessionToken) {
            throw new AuthenticationError('Missing session token after authentication');
        }
        const { dsInfo, webservices } = await establishSession(this.http, {
            sessionToken: this.session.sessionToken,
            trustToken: this.session.trustToken,
            accountCountry: this.session.accountCountry,
            clientId: this.session.clientId,
        });
        this.session.dsid = String(dsInfo.dsid);
        this.session.webservices = webservices;
        await this.persist();
    }

    private async persist(): Promise<void> {
        this.session.cookies = this.jar.toJSON();
        await this.storage.write(this.storageKey(), new TextEncoder().encode(JSON.stringify(this.session)));
    }

    get isAuthenticated(): boolean {
        return Boolean(this.session.dsid && this.session.webservices);
    }

    get dsid(): string | undefined {
        return this.session.dsid;
    }

    get webservices(): WebservicesMap | undefined {
        return this.session.webservices;
    }

    /** Resolve a discovered service's base URL (e.g. `ckdatabasews`, `drivews`). */
    serviceUrl(name: string): string | undefined {
        return this.session.webservices?.[name]?.url;
    }

    /**
     * Make an authenticated request against a service base URL, appending the
     * account `dsid` and replaying session cookies. The building block for
     * future service clients (Photos, Drive, Find My).
     */
    async request<T = unknown>(serviceUrl: string, pathname: string, init: RequestInit & { json?: unknown } = {}): Promise<HttpResponse<T>> {
        const url = new URL(pathname, serviceUrl);
        if (this.session.dsid) url.searchParams.set('dsid', this.session.dsid);
        const headers = new Headers(init.headers);
        for (const [key, value] of Object.entries(serviceBaseHeaders())) {
            if (!headers.has(key)) headers.set(key, value);
        }
        return this.http.send<T>(url.toString(), { ...init, headers });
    }

    /**
     * Download binary content from a fully-qualified URL (e.g. a CloudKit asset
     * `downloadURL`), replaying session cookies. The URL is used verbatim — no
     * `dsid` is appended, since these URLs are already signed.
     */
    async download(url: string): Promise<Uint8Array> {
        const res = await this.http.raw(url, { headers: { 'User-Agent': USER_AGENT } });
        if (!res.ok) throw new ICloudError(`Download failed (${res.status})`, res.status);
        return new Uint8Array(await res.arrayBuffer());
    }

    /** A Photos (CloudKit) service bound to this client. */
    photos(zoneName?: string): PhotosService {
        return new PhotosService(this, zoneName);
    }

    /** Forget the persisted session and reset in-memory state. */
    async logout(): Promise<void> {
        await this.storage.remove(this.storageKey());
        this.session = {
            version: SESSION_VERSION,
            accountName: this.accountName,
            clientId: this.session.clientId,
            cookies: [],
        };
        this.rebuild();
    }
}

export type { HttpResponse } from './http/client.js';
