import { ICloudClient } from '@icloudsync/icloud';
import type { LoginResult, PhotoResource, PhotosService, SessionStore, TwoFactorOptions } from '@icloudsync/icloud';
import { AccountsService } from '../accounts/accounts.service.js';
import { defaultArchivePrefix } from './storage/photo.prefix.js';

/** An account plus whether it currently has an authenticated session loaded. */
export interface AccountStatus {
    /** The account's UUID (its internal identity). */
    id: string;
    /** The Apple ID email (for display). */
    account: string;
    authenticated: boolean;
}

/** Begin-login result, carrying the (possibly newly created) account id. */
export type AccountLoginResult = LoginResult & { id: string };

/** Builds the per-account {@link SessionStore} bound to an account id. */
export type SessionStoreFactory = (accountId: string) => SessionStore;

/**
 * Application-facing iCloud service managing **multiple** accounts. Each account
 * gets its own {@link ICloudClient}, lazily created and cached in a pool keyed by
 * the account's UUID; each client persists its session onto that account's row
 * via a per-account {@link SessionStore} ({@link SessionStoreFactory}). The
 * Apple ID email stays the real iCloud login (looked up per account); the UUID
 * is the internal identity used by callers, storage, and the client cache.
 *
 * Every operation names the account id it acts on, so concurrent logins (e.g.
 * two accounts mid-2FA) don't clobber each other. An account is registered on
 * its first {@link login} and dropped by {@link remove}.
 */
export class ICloudService {
    private readonly clients = new Map<string, ICloudClient>();
    private restored = false;

    constructor(
        private readonly sessionStoreFor: SessionStoreFactory,
        private readonly accounts: AccountsService,
    ) {}

    /** Build a client for a known (id, email) pair, wiring its per-account session store. */
    private buildClient(accountId: string, accountName: string): ICloudClient {
        return new ICloudClient({ accountName, sessionStore: this.sessionStoreFor(accountId) });
    }

    /** Get (or lazily create) the cached client for `accountId`, resolving its Apple ID. */
    private async clientFor(accountId: string): Promise<ICloudClient> {
        let client = this.clients.get(accountId);
        if (!client) {
            const account = await this.accounts.getById(accountId);
            if (!account) throw new Error(`unknown account: ${accountId}`);
            client = this.buildClient(account.id, account.accountName);
            this.clients.set(accountId, client);
        }
        return client;
    }

    /** All registered accounts (id + Apple ID), oldest first. */
    async listAccounts(): Promise<Array<{ id: string; account: string }>> {
        const accounts = await this.accounts.list();
        return accounts.map(a => ({ id: a.id, account: a.accountName }));
    }

    /** Whether `accountId` currently has an authenticated session loaded. */
    isAuthenticated(accountId: string): boolean {
        return this.clients.get(accountId)?.isAuthenticated ?? false;
    }

    /**
     * Load every registered account's persisted session once (idempotent). Call
     * on boot so `/icloud/accounts` reflects auth state immediately after a
     * restart rather than only after the first sync run.
     */
    async restore(): Promise<void> {
        if (this.restored) return;
        for (const account of await this.accounts.list()) {
            if (!this.clients.has(account.id)) this.clients.set(account.id, this.buildClient(account.id, account.accountName));
            await this.clients.get(account.id)!.restore();
        }
        this.restored = true;
    }

    /** Load a single account's persisted session; returns whether it is authenticated. */
    async restoreAccount(accountId: string): Promise<boolean> {
        return (await this.clientFor(accountId)).restore();
    }

    /** The registered accounts with their live auth status (restores sessions first). */
    async accountsStatus(): Promise<AccountStatus[]> {
        await this.restore();
        const accounts = await this.accounts.list();
        return accounts.map(a => ({ id: a.id, account: a.accountName, authenticated: this.isAuthenticated(a.id) }));
    }

    /**
     * The effective photo-archive path prefix for `accountId`: its custom
     * `archive_prefix` when set, else the Apple ID's local part (see
     * {@link defaultArchivePrefix}).
     */
    async archivePrefix(accountId: string): Promise<string> {
        const account = await this.accounts.getById(accountId);
        if (!account) throw new Error(`unknown account: ${accountId}`);
        return account.archivePrefix ?? defaultArchivePrefix(account);
    }

    /**
     * Begin authentication for the Apple ID `accountName`, registering it as a
     * known account (idempotent). Returns the account's id alongside the login
     * state, so the caller can address the rest of the 2FA flow by id.
     */
    async login(accountName: string, password: string): Promise<AccountLoginResult> {
        const id = await this.accounts.create(accountName);
        const result = await (await this.clientFor(id)).login(password);
        return { ...result, id };
    }

    /** Ask Apple to push a security code to the account's trusted devices. */
    async requestDeviceCode(accountId: string): Promise<void> {
        return (await this.clientFor(accountId)).requestDeviceCode();
    }

    /** Complete an `mfaRequired` login with a code pushed to a trusted device. */
    async submitSecurityCode(accountId: string, code: string): Promise<LoginResult> {
        return (await this.clientFor(accountId)).submitSecurityCode(code);
    }

    /** Inspect the 2FA delivery options (trusted device count + SMS-capable phone numbers). */
    async getTwoFactorOptions(accountId: string): Promise<TwoFactorOptions> {
        return (await this.clientFor(accountId)).getTwoFactorOptions();
    }

    /** Request that an SMS security code be sent to a trusted phone number. */
    async requestPhoneCode(accountId: string, phoneId: number): Promise<void> {
        return (await this.clientFor(accountId)).requestPhoneCode(phoneId);
    }

    /** Complete an `mfaRequired` login with an SMS code sent to a phone number. */
    async submitPhoneCode(accountId: string, code: string, phoneId: number): Promise<LoginResult> {
        return (await this.clientFor(accountId)).submitPhoneCode(code, phoneId);
    }

    /** Forget an account's persisted session but keep it registered (so the UI can re-login). */
    async logout(accountId: string): Promise<void> {
        return (await this.clientFor(accountId)).logout();
    }

    /** Forget the session and unregister the account entirely (cascades to its photos). */
    async remove(accountId: string): Promise<void> {
        await (await this.clientFor(accountId)).logout();
        this.clients.delete(accountId);
        await this.accounts.remove(accountId);
    }

    /** The iCloud Photos (CloudKit) service for `accountId`. */
    async photos(accountId: string, zoneName?: string): Promise<PhotosService> {
        return (await this.clientFor(accountId)).photos(zoneName);
    }

    /**
     * Download binary content from a fully-qualified, already-signed iCloud URL
     * (e.g. a CloudKit asset `downloadURL`) using `accountId`'s session,
     * restoring it first so the proxy works on a cold container.
     */
    async download(accountId: string, url: string): Promise<Uint8Array> {
        await this.restoreAccount(accountId);
        return (await this.clientFor(accountId)).download(url);
    }

    /**
     * Re-fetch fresh, non-expired rendition URLs for one asset by re-looking it up
     * in CloudKit. The persisted `downloadURL`s are signed and expire within hours
     * of a sync, so the download proxy calls this to heal a stale URL on demand.
     * Both the asset and (when given) its master record are looked up so derived
     * and original renditions all come back. Returns the fresh resource map, or
     * `undefined` if the record no longer resolves.
     */
    async refreshRenditions(
        accountId: string,
        recordName: string,
        masterRecordName?: string,
        zoneName?: string,
    ): Promise<Record<string, PhotoResource> | undefined> {
        await this.restoreAccount(accountId);
        const photos = await this.photos(accountId, zoneName);
        const names = masterRecordName && masterRecordName !== recordName ? [recordName, masterRecordName] : [recordName];
        const asset = await photos.lookup(names);
        return asset?.resources;
    }

    /** Escape hatch to the underlying client for advanced use. */
    raw(accountId: string): Promise<ICloudClient> {
        return this.clientFor(accountId);
    }
}
