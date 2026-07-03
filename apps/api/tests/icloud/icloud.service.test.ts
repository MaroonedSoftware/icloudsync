import type { SessionStore } from '@icloudsync/icloud';
import { describe, expect, it } from 'vitest';
import { AccountsService, type Account } from '../../src/modules/accounts/accounts.service.js';
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

/** In-memory stand-in for the DB-backed AccountsService (UUID-keyed registry). */
class FakeAccounts {
    readonly rows: Account[] = [];
    private seq = 0;
    constructor(...names: string[]) {
        for (const n of names) this.rows.push({ id: `acc-${this.seq++}`, accountName: n, archivePrefix: null, relocationError: null, relocationFrom: null });
    }
    list = (): Promise<Account[]> => Promise.resolve([...this.rows]);
    create = (accountName: string): Promise<string> => {
        let row = this.rows.find(r => r.accountName === accountName);
        if (!row) {
            row = { id: `acc-${this.seq++}`, accountName, archivePrefix: null, relocationError: null, relocationFrom: null };
            this.rows.push(row);
        }
        return Promise.resolve(row.id);
    };
    getById = (id: string): Promise<Account | undefined> => Promise.resolve(this.rows.find(r => r.id === id));
    remove = (id: string): Promise<void> => {
        const i = this.rows.findIndex(r => r.id === id);
        if (i >= 0) this.rows.splice(i, 1);
        return Promise.resolve();
    };
    has = (id: string): Promise<boolean> => Promise.resolve(this.rows.some(r => r.id === id));
    /** Test helper: the id assigned to a seeded/created account name. */
    idOf = (accountName: string): string => this.rows.find(r => r.accountName === accountName)!.id;
}

const make = (...seed: string[]) => {
    const accounts = new FakeAccounts(...seed);
    const service = new ICloudService(() => new MemStore(), accounts as unknown as AccountsService);
    return { service, accounts };
};

describe('ICloudService multi-account', () => {
    it('has no accounts and none authenticated before any login', async () => {
        const { service } = make();
        expect(await service.listAccounts()).toEqual([]);
        expect(await service.accountsStatus()).toEqual([]);
        expect(service.isAuthenticated('acc-0')).toBe(false);
    });

    it('restores every registered account (unauthenticated without a session blob)', async () => {
        const { service, accounts } = make('a@icloud.com', 'b@icloud.com');
        await service.restore();
        expect(await service.accountsStatus()).toEqual([
            { id: accounts.idOf('a@icloud.com'), account: 'a@icloud.com', authenticated: false },
            { id: accounts.idOf('b@icloud.com'), account: 'b@icloud.com', authenticated: false },
        ]);
    });

    it('registers the account on login', async () => {
        const { service, accounts } = make();
        // login() registers the account before contacting Apple; bound the call so the
        // (network) auth attempt can't hang the test.
        await Promise.race([service.login('chosen@icloud.com', 'pw').catch(() => undefined), new Promise(r => setTimeout(r, 1000))]);
        expect(accounts.rows.map(r => r.accountName)).toContain('chosen@icloud.com');
        expect((await service.listAccounts()).map(a => a.account)).toContain('chosen@icloud.com');
    });

    it('restoreAccount reports an account with no persisted session as unauthenticated', async () => {
        const { service, accounts } = make('solo@icloud.com');
        const id = accounts.idOf('solo@icloud.com');
        expect(await service.restoreAccount(id)).toBe(false);
        expect(service.isAuthenticated(id)).toBe(false);
    });

    it('reuses one cached client per account across calls', async () => {
        const { service, accounts } = make('a@icloud.com', 'b@icloud.com');
        const a = accounts.idOf('a@icloud.com');
        const b = accounts.idOf('b@icloud.com');
        expect(await service.raw(a)).toBe(await service.raw(a));
        expect(await service.raw(a)).not.toBe(await service.raw(b));
    });

    it('restore() is idempotent: accounts registered after the first restore are not auto-restored', async () => {
        const { service, accounts } = make('a@icloud.com');
        await service.restore();
        await accounts.create('late@icloud.com');
        await service.restore(); // second call is a no-op, so `late` was never restored
        expect(service.isAuthenticated(accounts.idOf('late@icloud.com'))).toBe(false);
    });

    it('accountsStatus lists every registered account, defaulting to unauthenticated', async () => {
        const { service, accounts } = make('a@icloud.com');
        await accounts.create('b@icloud.com');
        expect(await service.accountsStatus()).toEqual([
            { id: accounts.idOf('a@icloud.com'), account: 'a@icloud.com', authenticated: false },
            { id: accounts.idOf('b@icloud.com'), account: 'b@icloud.com', authenticated: false },
        ]);
    });

    it('forgets the session but keeps the account on logout, and unregisters on remove', async () => {
        const { service, accounts } = make('a@icloud.com');
        const id = accounts.idOf('a@icloud.com');
        await service.logout(id);
        expect(accounts.rows.map(r => r.accountName)).toEqual(['a@icloud.com']); // still registered

        await service.remove(id);
        expect(accounts.rows).toEqual([]);
        expect(await service.listAccounts()).toEqual([]);
    });
});
