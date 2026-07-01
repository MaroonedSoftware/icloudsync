import { describe, expect, it } from 'vitest';
import { AccountsService } from '../../src/modules/accounts/accounts.service.js';
import type { DB } from '../../src/modules/data/kysely.js';
import type { Kysely } from 'kysely';

/**
 * Minimal in-memory stand-in for the Kysely query builder covering exactly the
 * chains {@link AccountsService} issues against the `icloudAccounts` table:
 * `selectFrom(...).select(...).orderBy(...).orderBy(...).execute()`,
 * `insertInto(...).values(...).onConflict(oc => oc.column(...).doNothing()).execute()`,
 * `deleteFrom(...).where(...).execute()` and the `executeTakeFirst()` existence probe.
 * Rows are plain `{ accountName, addedAt }` records so ordering can be exercised.
 */
class FakeDb {
    private seq = 0;
    readonly rows: { accountName: string; addedAt: number }[] = [];

    /** Seed a row directly, bypassing insert semantics (for ordering setup). */
    seed(accountName: string, addedAt: number): void {
        this.rows.push({ accountName, addedAt });
    }

    selectFrom(_table: 'icloudAccounts') {
        const self = this;
        const orderKeys: ('addedAt' | 'accountName')[] = [];
        let whereName: string | undefined;
        const builder = {
            select(_col: 'accountName') {
                return builder;
            },
            where(_col: 'accountName', _op: '=', value: string) {
                whereName = value;
                return builder;
            },
            orderBy(col: 'addedAt' | 'accountName', _dir: 'asc') {
                orderKeys.push(col);
                return builder;
            },
            execute() {
                const sorted = [...self.rows].sort((a, b) => {
                    for (const k of orderKeys) {
                        if (k === 'addedAt' && a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
                        if (k === 'accountName' && a.accountName !== b.accountName)
                            return a.accountName < b.accountName ? -1 : 1;
                    }
                    return 0;
                });
                return Promise.resolve(sorted.map(r => ({ accountName: r.accountName })));
            },
            executeTakeFirst() {
                const row = self.rows.find(r => r.accountName === whereName);
                return Promise.resolve(row ? { accountName: row.accountName } : undefined);
            },
        };
        return builder;
    }

    insertInto(_table: 'icloudAccounts') {
        const self = this;
        let pending: { accountName: string } | undefined;
        let ignoreConflict = false;
        const builder = {
            values(v: { accountName: string }) {
                pending = v;
                return builder;
            },
            onConflict(fn: (oc: { column(c: 'accountName'): { doNothing(): unknown } }) => unknown) {
                fn({ column: () => ({ doNothing: () => (ignoreConflict = true) }) });
                return builder;
            },
            execute() {
                if (pending) {
                    const exists = self.rows.some(r => r.accountName === pending!.accountName);
                    if (!exists) self.rows.push({ accountName: pending.accountName, addedAt: self.seq++ });
                    else if (!ignoreConflict) throw new Error('conflict');
                }
                return Promise.resolve();
            },
        };
        return builder;
    }

    deleteFrom(_table: 'icloudAccounts') {
        const self = this;
        let whereName: string | undefined;
        const builder = {
            where(_col: 'accountName', _op: '=', value: string) {
                whereName = value;
                return builder;
            },
            execute() {
                const i = self.rows.findIndex(r => r.accountName === whereName);
                if (i >= 0) self.rows.splice(i, 1);
                return Promise.resolve();
            },
        };
        return builder;
    }
}

const make = () => {
    const db = new FakeDb();
    const service = new AccountsService(db as unknown as Kysely<DB>);
    return { service, db };
};

describe('AccountsService', () => {
    it('lists nothing when no accounts are registered', async () => {
        const { service } = make();
        expect(await service.list()).toEqual([]);
    });

    it('registers an account and reports it as present', async () => {
        const { service } = make();
        expect(await service.has('a@icloud.com')).toBe(false);
        await service.add('a@icloud.com');
        expect(await service.has('a@icloud.com')).toBe(true);
        expect(await service.list()).toEqual(['a@icloud.com']);
    });

    it('is idempotent: adding the same account twice keeps a single entry', async () => {
        const { service } = make();
        await service.add('dup@icloud.com');
        await service.add('dup@icloud.com');
        expect(await service.list()).toEqual(['dup@icloud.com']);
    });

    it('lists accounts oldest first, breaking ties by name', async () => {
        const { service } = make();
        await service.add('second@icloud.com');
        await service.add('first@icloud.com');
        await service.add('third@icloud.com');
        expect(await service.list()).toEqual(['second@icloud.com', 'first@icloud.com', 'third@icloud.com']);
    });

    it('orders by accountName when accounts share an addedAt timestamp', async () => {
        const { service, db } = make();
        db.seed('charlie@icloud.com', 0);
        db.seed('alpha@icloud.com', 0);
        db.seed('bravo@icloud.com', 0);
        expect(await service.list()).toEqual(['alpha@icloud.com', 'bravo@icloud.com', 'charlie@icloud.com']);
    });

    it('removes a registered account', async () => {
        const { service } = make();
        await service.add('gone@icloud.com');
        await service.remove('gone@icloud.com');
        expect(await service.has('gone@icloud.com')).toBe(false);
        expect(await service.list()).toEqual([]);
    });

    it('treats removing an unregistered account as a no-op', async () => {
        const { service } = make();
        await service.add('keep@icloud.com');
        await expect(service.remove('never@icloud.com')).resolves.toBeUndefined();
        expect(await service.list()).toEqual(['keep@icloud.com']);
    });

    it('reports has() as false for an account that was never added', async () => {
        const { service } = make();
        await service.add('present@icloud.com');
        expect(await service.has('absent@icloud.com')).toBe(false);
    });
});
