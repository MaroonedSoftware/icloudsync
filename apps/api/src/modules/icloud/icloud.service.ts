import { ICloudClient } from '@icloudsync/icloud';
import type { LoginResult, PhotosService, SessionStore, TwoFactorOptions } from '@icloudsync/icloud';
import { AccountsService } from '../accounts/accounts.service.js';

/** An account plus whether it currently has an authenticated session loaded. */
export interface AccountStatus {
    account: string;
    authenticated: boolean;
}

/**
 * Application-facing iCloud service managing **multiple** accounts. Each account
 * gets its own {@link ICloudClient}, lazily created and cached in a pool keyed by
 * Apple ID; all sessions share one encrypted {@link SessionStore} (blobs are
 * namespaced per account by the client). The set of accounts is persisted via
 * {@link AccountsService}, so the worker and API rediscover them on restart.
 *
 * Every operation names the account it acts on, so concurrent logins (e.g. two
 * accounts mid-2FA) don't clobber each other. An account is registered on its
 * first {@link login} and dropped by {@link remove}.
 */
export class ICloudService {
    private readonly clients = new Map<string, ICloudClient>();
    private restored = false;

    constructor(
        private readonly store: SessionStore,
        private readonly accounts: AccountsService,
    ) {}

    /** Get (or lazily create) the cached client for `accountName`. */
    private client(accountName: string): ICloudClient {
        let client = this.clients.get(accountName);
        if (!client) {
            client = new ICloudClient({ accountName, sessionStore: this.store });
            this.clients.set(accountName, client);
        }
        return client;
    }

    /** All registered Apple IDs, oldest first. */
    listAccounts(): Promise<string[]> {
        return this.accounts.list();
    }

    /** Whether `accountName` currently has an authenticated session loaded. */
    isAuthenticated(accountName: string): boolean {
        return this.clients.get(accountName)?.isAuthenticated ?? false;
    }

    /**
     * Load every registered account's persisted session once (idempotent). Call
     * on boot so `/icloud/accounts` reflects auth state immediately after a
     * restart rather than only after the first sync run.
     */
    async restore(): Promise<void> {
        if (this.restored) return;
        for (const account of await this.accounts.list()) {
            await this.client(account).restore();
        }
        this.restored = true;
    }

    /** Load a single account's persisted session; returns whether it is authenticated. */
    restoreAccount(accountName: string): Promise<boolean> {
        return this.client(accountName).restore();
    }

    /** The registered accounts with their live auth status (restores sessions first). */
    async accountsStatus(): Promise<AccountStatus[]> {
        await this.restore();
        const accounts = await this.accounts.list();
        return accounts.map(account => ({ account, authenticated: this.isAuthenticated(account) }));
    }

    /** Begin authentication for `accountName`; registers it as a known account. */
    async login(accountName: string, password: string): Promise<LoginResult> {
        await this.accounts.add(accountName);
        return this.client(accountName).login(password);
    }

    /** Ask Apple to push a security code to the account's trusted devices. */
    requestDeviceCode(accountName: string): Promise<void> {
        return this.client(accountName).requestDeviceCode();
    }

    /** Complete an `mfaRequired` login with a code pushed to a trusted device. */
    submitSecurityCode(accountName: string, code: string): Promise<LoginResult> {
        return this.client(accountName).submitSecurityCode(code);
    }

    /** Inspect the 2FA delivery options (trusted device count + SMS-capable phone numbers). */
    getTwoFactorOptions(accountName: string): Promise<TwoFactorOptions> {
        return this.client(accountName).getTwoFactorOptions();
    }

    /** Request that an SMS security code be sent to a trusted phone number. */
    requestPhoneCode(accountName: string, phoneId: number): Promise<void> {
        return this.client(accountName).requestPhoneCode(phoneId);
    }

    /** Complete an `mfaRequired` login with an SMS code sent to a phone number. */
    submitPhoneCode(accountName: string, code: string, phoneId: number): Promise<LoginResult> {
        return this.client(accountName).submitPhoneCode(code, phoneId);
    }

    /** Forget an account's persisted session but keep it registered (so the UI can re-login). */
    logout(accountName: string): Promise<void> {
        return this.client(accountName).logout();
    }

    /** Forget the session and unregister the account entirely. */
    async remove(accountName: string): Promise<void> {
        await this.client(accountName).logout();
        this.clients.delete(accountName);
        await this.accounts.remove(accountName);
    }

    /** The iCloud Photos (CloudKit) service for `accountName`. */
    photos(accountName: string, zoneName?: string): PhotosService {
        return this.client(accountName).photos(zoneName);
    }

    /**
     * Download binary content from a fully-qualified, already-signed iCloud URL
     * (e.g. a CloudKit asset `downloadURL`) using `accountName`'s session,
     * restoring it first so the proxy works on a cold container.
     */
    async download(accountName: string, url: string): Promise<Uint8Array> {
        await this.restoreAccount(accountName);
        return this.client(accountName).download(url);
    }

    /** Escape hatch to the underlying client for advanced use. */
    raw(accountName: string): ICloudClient {
        return this.client(accountName);
    }
}
