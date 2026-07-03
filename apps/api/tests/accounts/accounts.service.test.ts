import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../src/modules/accounts/accounts.service.js';
import type { DB } from '../../src/modules/data/kysely.js';

/**
 * Integration test for the account registry against the project's local
 * Postgres (the UUID-keyed schema, `create`/`getById` upserts, and cascade
 * removal can't be faithfully faked). Self-skipping when the database is
 * unreachable, so the suite stays green without it.
 *
 * All accounts use the `PREFIX` so the suite can isolate itself (delete its own
 * rows before each test, filter `list()` down to them) and never trip over rows
 * left by other integration suites running against the same database.
 */
const CONNECTION = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/icloudsync?sslmode=disable';
const PREFIX = 'svc-int-';
const name = (local: string): string => `${PREFIX}${local}@icloud.com`;

let db: Kysely<DB> | undefined;
let service: AccountsService;
let available = false;

/** The registered accounts whose name starts with our test prefix, in list order. */
async function ours(): Promise<string[]> {
    const all = await service.list();
    return all.filter(a => a.accountName.startsWith(PREFIX)).map(a => a.accountName);
}

beforeAll(async () => {
    try {
        const pool = new KyselyPool({ connectionString: CONNECTION, types: KyselyPgTypeOverrides });
        db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: KyselyDefaultPlugins });
        await sql`select 1`.execute(db);
        service = new AccountsService(db);
        available = true;
    } catch {
        available = false;
        if (db) await db.destroy();
        db = undefined;
    }
});

afterAll(async () => {
    if (db) {
        await db.deleteFrom('icloudAccounts').where('accountName', 'like', `${PREFIX}%`).execute();
        await db.destroy();
    }
});

beforeEach(async () => {
    if (db) await db.deleteFrom('icloudAccounts').where('accountName', 'like', `${PREFIX}%`).execute();
});

const guard = (): boolean => {
    if (!available) console.warn('[accounts.service.int] skipped — Postgres unreachable');
    return available;
};

describe('AccountsService', () => {
    it('registers an account and reports it as present by id', async () => {
        if (!guard()) return;
        const id = await service.create(name('a'));
        expect(id).toMatch(/^[0-9a-f-]{36}$/i);
        expect(await service.has(id)).toBe(true);
        expect(await ours()).toEqual([name('a')]);
    });

    it('is idempotent: creating the same account twice keeps one row and returns the same id', async () => {
        if (!guard()) return;
        const first = await service.create(name('dup'));
        const second = await service.create(name('dup'));
        expect(second).toBe(first);
        expect(await ours()).toEqual([name('dup')]);
    });

    it('lists accounts oldest first', async () => {
        if (!guard()) return;
        await service.create(name('second'));
        await service.create(name('first'));
        await service.create(name('third'));
        expect(await ours()).toEqual([name('second'), name('first'), name('third')]);
    });

    it('orders by accountName when accounts share an addedAt timestamp', async () => {
        if (!guard() || !db) return;
        const at = sql`timestamptz '2026-01-01 00:00:00+00'`;
        await db
            .insertInto('icloudAccounts')
            .values([
                { accountName: name('charlie'), addedAt: at },
                { accountName: name('alpha'), addedAt: at },
                { accountName: name('bravo'), addedAt: at },
            ])
            .execute();
        expect(await ours()).toEqual([name('alpha'), name('bravo'), name('charlie')]);
    });

    it('resolves an account by id and by name', async () => {
        if (!guard()) return;
        const id = await service.create(name('lookup'));
        expect(await service.getById(id)).toMatchObject({ id, accountName: name('lookup') });
        expect(await service.getByName(name('lookup'))).toMatchObject({ id });
        expect(await service.getById('00000000-0000-4000-8000-000000000000')).toBeUndefined();
        expect(await service.getByName('nobody@icloud.com')).toBeUndefined();
    });

    it('pins and clears a custom archive prefix', async () => {
        if (!guard()) return;
        const id = await service.create(name('prefix'));
        expect((await service.getById(id))?.archivePrefix ?? null).toBeNull();

        await service.setArchivePrefix(id, 'family-photos');
        expect((await service.getById(id))?.archivePrefix).toBe('family-photos');

        await service.setArchivePrefix(id, null);
        expect((await service.getById(id))?.archivePrefix ?? null).toBeNull();
    });

    it('records and clears the last relocation state (error + resume source)', async () => {
        if (!guard()) return;
        const id = await service.create(name('reloc'));
        const fresh = await service.getById(id);
        expect(fresh?.relocationError ?? null).toBeNull();
        expect(fresh?.relocationFrom ?? null).toBeNull();

        await service.setRelocationState(id, 'Moved 3 file(s); 1 failed to move: storage down', 'old-prefix');
        const failed = await service.getById(id);
        expect(failed?.relocationError).toContain('1 failed to move');
        expect(failed?.relocationFrom).toBe('old-prefix'); // remembered for a retry

        await service.setRelocationState(id, null, null);
        const cleared = await service.getById(id);
        expect(cleared?.relocationError ?? null).toBeNull();
        expect(cleared?.relocationFrom ?? null).toBeNull();
    });

    it('removes a registered account', async () => {
        if (!guard()) return;
        const id = await service.create(name('gone'));
        await service.remove(id);
        expect(await service.has(id)).toBe(false);
        expect(await ours()).toEqual([]);
    });

    it('treats removing an unknown account as a no-op', async () => {
        if (!guard()) return;
        await service.create(name('keep'));
        await expect(service.remove('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
        expect(await ours()).toEqual([name('keep')]);
    });

    it('reports has() as false for an id that was never created', async () => {
        if (!guard()) return;
        await service.create(name('present'));
        expect(await service.has('00000000-0000-4000-8000-000000000000')).toBe(false);
    });
});
