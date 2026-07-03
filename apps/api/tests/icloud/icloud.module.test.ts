import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import { createRegistry } from 'injectkit';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountsService } from '../../src/modules/accounts/accounts.service.js';
import type { DB } from '../../src/modules/data/kysely.js';
import { ICloudConfig } from '../../src/modules/icloud/icloud.config.js';
import { ICloudService } from '../../src/modules/icloud/icloud.service.js';
import { registerICloud } from '../../src/modules/icloud/icloud.module.js';
import { AccountSessionStore } from '../../src/modules/icloud/storage/account.session.store.js';

/**
 * Integration test for `registerICloud` against the project's local Postgres:
 * the encryption salt is auto-persisted in `app_settings`, and a session written
 * under one derived key can be read back after a second boot derives the same
 * key from that persisted salt. Self-skipping when the database is unreachable.
 */
const CONNECTION = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/icloudsync?sslmode=disable';
const SALT_KEY = 'icloud_encryption_salt';
const ACCOUNT = 'module-int@icloud.com';

let db: Kysely<DB> | undefined;
let available = false;

const config = (): ICloudConfig => new ICloudConfig({ encryptionSecret: 'a-test-passphrase-1234' });

beforeAll(async () => {
    try {
        const pool = new KyselyPool({ connectionString: CONNECTION, types: KyselyPgTypeOverrides });
        db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: KyselyDefaultPlugins });
        await sql`select 1`.execute(db);
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

/** Register a fresh container over the shared db, returning its ICloudService + EncryptionProvider. */
async function boot(database: Kysely<DB>): Promise<{ icloud: ICloudService; encryption: EncryptionProvider }> {
    const registry = createRegistry();
    registry.register(AccountsService).useInstance(new AccountsService(database));
    await registerICloud(registry, config(), database);
    const container = registry.build();
    return { icloud: container.get(ICloudService), encryption: container.get(EncryptionProvider) };
}

describe('registerICloud (integration)', () => {
    it('wires a singleton ICloudService and auto-persists the encryption salt', async () => {
        if (!available || !db) {
            console.warn('[icloud.module.int] skipped — Postgres unreachable');
            return;
        }
        const registry = createRegistry();
        registry.register(AccountsService).useInstance(new AccountsService(db));
        await registerICloud(registry, config(), db);
        const container = registry.build();

        const service = container.get(ICloudService);
        expect(service).toBeInstanceOf(ICloudService);
        expect(service.isAuthenticated('00000000-0000-4000-8000-000000000000')).toBe(false);
        expect(container.get(ICloudService)).toBe(service); // singleton

        // The Argon2id salt was persisted (in app_settings) for reproducible key derivation.
        const row = await db.selectFrom('appSettings').select('value').where('key', '=', SALT_KEY).executeTakeFirstOrThrow();
        expect(row.value).toMatch(/^[0-9a-f]+$/);
    });

    it('reuses the persisted salt so a later boot can decrypt the prior session', async () => {
        if (!available || !db) return;

        // First boot: register an account and write an encrypted session onto its row.
        await db.deleteFrom('icloudAccounts').where('accountName', '=', ACCOUNT).execute();
        const id = await new AccountsService(db).create(ACCOUNT);
        const first = await boot(db);
        const blob = new TextEncoder().encode(JSON.stringify({ trustToken: 'persisted' }));
        await new AccountSessionStore(db, first.encryption, id).write('key', blob);

        // Second boot (fresh registry, same db) derives the same key from the
        // persisted salt and decrypts what the first boot wrote.
        const second = await boot(db);
        const read = await new AccountSessionStore(db, second.encryption, id).read('key');
        expect(read).not.toBeNull();
        expect(JSON.parse(new TextDecoder().decode(read!))).toEqual({ trustToken: 'persisted' });
    });
});
