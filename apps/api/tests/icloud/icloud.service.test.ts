import type { SessionStore } from '@icloudsync/icloud';
import { describe, expect, it } from 'vitest';
import { AccountsService } from '../../src/modules/accounts/accounts.service.js';
import { ICloudService } from '../../src/modules/icloud/icloud.service.js';

/** In-memory SessionStore so the service's session logic runs without network. */
class MemStore implements SessionStore {
    readonly map = new Map<string, Uint8Array>();
    read(key: string): Promise<Uint8Array | null> {
        return Promise.resolve(this.map.get(key) ?? null);
    }
    write(key: string, data: Uint8Array): Promise<void> {
        this.map.set(key, data);
        return Promise.resolve();
    }
    remove(key: string): Promise<void> {
        this.map.delete(key);
        return Promise.resolve();
    }
}

/** In-memory stand-in for the DB-backed AccountsService (registry only). */
class FakeAccounts {
    readonly accounts: string[];
    constructor(...seed: string[]) {
        this.accounts = [...seed];
    }
    list(): Promise<string[]> {
        return Promise.resolve([...this.accounts]);
    }
    add(account: string): Promise<void> {
        if (!this.accounts.includes(account)) this.accounts.push(account);
        return Promise.resolve();
    }
    remove(account: string): Promise<void> {
        const i = this.accounts.indexOf(account);
        if (i >= 0) this.accounts.splice(i, 1);
        return Promise.resolve();
    }
    has(account: string): Promise<boolean> {
        return Promise.resolve(this.accounts.includes(account));
    }
}

const make = (...seed: string[]) => {
    const accounts = new FakeAccounts(...seed);
    const service = new ICloudService(new MemStore(), accounts as unknown as AccountsService);
    return { service, accounts };
};

describe('ICloudService multi-account', () => {
    it('has no accounts and none authenticated before any login', async () => {
        const { service } = make();
        expect(await service.listAccounts()).toEqual([]);
        expect(await service.accountsStatus()).toEqual([]);
        expect(service.isAuthenticated('me@icloud.com')).toBe(false);
    });

    it('restores every registered account (unauthenticated without a session blob)', async () => {
        const { service } = make('a@icloud.com', 'b@icloud.com');
        await service.restore();
        expect(await service.accountsStatus()).toEqual([
            { account: 'a@icloud.com', authenticated: false },
            { account: 'b@icloud.com', authenticated: false },
        ]);
    });

    it('registers the account on login', async () => {
        const { service, accounts } = make();
        // login() registers the account before contacting Apple; bound the call so the
        // (network) auth attempt can't hang the test.
        await Promise.race([service.login('chosen@icloud.com', 'pw').catch(() => undefined), new Promise(r => setTimeout(r, 1000))]);
        expect(accounts.accounts).toContain('chosen@icloud.com');
        expect(await service.listAccounts()).toContain('chosen@icloud.com');
    });

    it('restoreAccount reports an account with no persisted session as unauthenticated', async () => {
        const { service } = make('solo@icloud.com');
        expect(await service.restoreAccount('solo@icloud.com')).toBe(false);
        expect(service.isAuthenticated('solo@icloud.com')).toBe(false);
    });

    it('reuses one cached client per account across calls', async () => {
        const { service } = make('a@icloud.com');
        expect(service.raw('a@icloud.com')).toBe(service.raw('a@icloud.com'));
        expect(service.raw('a@icloud.com')).not.toBe(service.raw('b@icloud.com'));
    });

    it('restore() is idempotent: accounts registered after the first restore are not auto-restored', async () => {
        const { service, accounts } = make('a@icloud.com');
        await service.restore();
        await accounts.add('late@icloud.com');
        await service.restore(); // second call is a no-op, so `late` was never restored
        expect(service.isAuthenticated('late@icloud.com')).toBe(false);
    });

    it('accountsStatus lists every registered account, defaulting to unauthenticated', async () => {
        const { service, accounts } = make('a@icloud.com');
        await accounts.add('b@icloud.com');
        expect(await service.accountsStatus()).toEqual([
            { account: 'a@icloud.com', authenticated: false },
            { account: 'b@icloud.com', authenticated: false },
        ]);
    });

    it('forgets the session but keeps the account on logout, and unregisters on remove', async () => {
        const { service, accounts } = make('a@icloud.com');
        await service.logout('a@icloud.com');
        expect(accounts.accounts).toEqual(['a@icloud.com']); // still registered

        await service.remove('a@icloud.com');
        expect(accounts.accounts).toEqual([]);
        expect(await service.listAccounts()).toEqual([]);
    });
});
