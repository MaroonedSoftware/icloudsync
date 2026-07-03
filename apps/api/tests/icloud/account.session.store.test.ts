import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountSessionStore } from '../../src/modules/icloud/storage/account.session.store.js';
import type { DB } from '../../src/modules/data/kysely.js';

/**
 * Integration test for the promoted session store against the project's local
 * Postgres: the encrypted `AuthSession` blob lives on the `session` column of the
 * account's row. Self-skipping when the database is unreachable.
 */
const CONNECTION = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/icloudsync?sslmode=disable';
const ACCOUNT = 'session-store-int@icloud.com';

let db: Kysely<DB> | undefined;
let encryption: EncryptionProvider;
let accountId: string;
let available = false;

beforeAll(async () => {
    try {
        const pool = new KyselyPool({ connectionString: CONNECTION, types: KyselyPgTypeOverrides });
        db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: KyselyDefaultPlugins });
        await sql`select 1`.execute(db);
        const { key } = await EncryptionProvider.createKey('a-test-passphrase-1234');
        encryption = new EncryptionProvider(key);
        await db.deleteFrom('icloudAccounts').where('accountName', '=', ACCOUNT).execute();
        const row = await db.insertInto('icloudAccounts').values({ accountName: ACCOUNT }).returning('id').executeTakeFirstOrThrow();
        accountId = row.id;
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

describe('AccountSessionStore (integration)', () => {
    it('reads null when no session has been written yet', async () => {
        if (!available || !db) {
            console.warn('[account.session.store.int] skipped — Postgres unreachable');
            return;
        }
        const store = new AccountSessionStore(db, encryption, accountId);
        expect(await store.read('ignored-key')).toBeNull();
    });

    it('round-trips an encrypted blob through the account row and stamps session_updated_at', async () => {
        if (!available || !db) return;
        const store = new AccountSessionStore(db, encryption, accountId);
        const blob = new TextEncoder().encode(JSON.stringify({ trustToken: 'abc', cookies: [{ name: 'X', value: '1' }] }));

        await store.write('ignored-key', blob);

        // Persisted ciphertext is not the plaintext (it was encrypted at rest).
        const raw = await db.selectFrom('icloudAccounts').select(['session', 'sessionUpdatedAt']).where('id', '=', accountId).executeTakeFirstOrThrow();
        expect(raw.session).not.toBeNull();
        expect(Buffer.from(raw.session as Buffer).toString('utf-8')).not.toContain('trustToken');
        expect(raw.sessionUpdatedAt).not.toBeNull();

        // A fresh store instance reads and decrypts the same bytes back.
        const read = await new AccountSessionStore(db, encryption, accountId).read('ignored-key');
        expect(read).not.toBeNull();
        expect(JSON.parse(new TextDecoder().decode(read!))).toEqual({ trustToken: 'abc', cookies: [{ name: 'X', value: '1' }] });
    });

    it('clears the session on remove', async () => {
        if (!available || !db) return;
        const store = new AccountSessionStore(db, encryption, accountId);
        await store.write('ignored-key', new TextEncoder().encode('{"trustToken":"z"}'));
        await store.remove('ignored-key');
        expect(await store.read('ignored-key')).toBeNull();
    });
});
