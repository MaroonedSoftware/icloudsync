import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountsService } from '../../src/modules/accounts/accounts.service.js';
import type { DB } from '../../src/modules/data/kysely.js';

/**
 * Integration test for per-account layout/naming overrides against the project's
 * local Postgres. Self-skipping when the database is unreachable, so the suite
 * stays green without it.
 */
const CONNECTION = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/icloudsync?sslmode=disable';
const ACCOUNT = 'settings-int@icloud.com';

let db: Kysely<DB> | undefined;
let accounts: AccountsService;
let available = false;

beforeAll(async () => {
    try {
        const pool = new KyselyPool({ connectionString: CONNECTION, types: KyselyPgTypeOverrides });
        db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: KyselyDefaultPlugins });
        await sql`select 1`.execute(db);
        accounts = new AccountsService(db);
        available = true;
    } catch {
        available = false;
        if (db) await db.destroy();
        db = undefined;
    }
});

afterAll(async () => {
    if (db) {
        await db.deleteFrom('icloudAccounts').where('accountName', '=', ACCOUNT).execute();
        await db.destroy();
    }
});

describe('AccountsService photo overrides (integration)', () => {
    it('defaults to inheriting (all null), then pins and clears overrides', async () => {
        if (!available || !db) {
            console.warn('[accounts.settings.int] skipped — Postgres unreachable');
            return;
        }
        await db.deleteFrom('icloudAccounts').where('accountName', '=', ACCOUNT).execute();
        const id = await accounts.create(ACCOUNT);

        // A fresh account inherits everything.
        expect(await accounts.photoSettings(id)).toEqual({ destination: null, preset: null, layout: null, naming: null });

        // Pin the destination/preset and the layout; naming stays inherited.
        await accounts.setPhotoSettings(id, { destination: 'immich', preset: 'browsable', layout: 'date' });
        expect(await accounts.photoSettings(id)).toEqual({ destination: 'immich', preset: 'browsable', layout: 'date', naming: null });

        // Pin naming too (a fresh instance proves it's persisted, not in-memory).
        await accounts.setPhotoSettings(id, { naming: 'hash' });
        const fresh = new AccountsService(db);
        expect(await fresh.photoSettings(id)).toEqual({ destination: 'immich', preset: 'browsable', layout: 'date', naming: 'hash' });

        // Clearing the destination and layout leaves the rest intact.
        await accounts.setPhotoSettings(id, { destination: null, layout: null });
        expect(await fresh.photoSettings(id)).toEqual({ destination: null, preset: 'browsable', layout: null, naming: 'hash' });
    });

    it('reads an unknown account as fully inherited', async () => {
        if (!available || !db) {
            console.warn('[accounts.settings.int] skipped — Postgres unreachable');
            return;
        }
        expect(await accounts.photoSettings('00000000-0000-4000-8000-000000000000')).toEqual({ destination: null, preset: null, layout: null, naming: null });
    });
});
