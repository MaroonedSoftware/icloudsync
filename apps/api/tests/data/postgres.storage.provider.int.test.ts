import { buffer as readStream } from 'node:stream/consumers';
import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import { StorageObjectNotFoundError } from '@maroonedsoftware/storage';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStorageProvider } from '../../src/modules/data/postgres.storage.provider.js';
import type { DB } from '../../src/modules/data/kysely.js';

const CONNECTION = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/icloudsync?sslmode=disable';
const PREFIX = 'test/psp/';

let db: Kysely<DB> | undefined;
let storage: PostgresStorageProvider;
let available = false;

beforeAll(async () => {
    try {
        const pool = new KyselyPool({ connectionString: CONNECTION, types: KyselyPgTypeOverrides });
        db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: KyselyDefaultPlugins });
        await sql`select 1`.execute(db);
        storage = new PostgresStorageProvider(db);
        available = true;
    } catch {
        available = false;
        if (db) await db.destroy();
        db = undefined;
    }
});

afterAll(async () => {
    if (db) {
        await db.deleteFrom('storageObjects').where('key', 'like', `${PREFIX}%`).execute();
        await db.destroy();
    }
});

const text = async (key: string) => (await readStream(await storage.read(key))).toString('utf-8');

describe('PostgresStorageProvider (integration)', () => {
    it('round-trips strings and buffers, and reports existence', async () => {
        if (!available || !db) {
            console.warn('[postgres.storage.provider.int] skipped — Postgres unreachable');
            return;
        }
        await db.deleteFrom('storageObjects').where('key', 'like', `${PREFIX}%`).execute();

        await storage.write(`${PREFIX}a`, 'hello', { contentType: 'text/plain' });
        await storage.write(`${PREFIX}b`, Buffer.from([1, 2, 3]));

        expect(await text(`${PREFIX}a`)).toBe('hello');
        expect([...(await readStream(await storage.read(`${PREFIX}b`)))]).toEqual([1, 2, 3]);
        expect(await storage.exists(`${PREFIX}a`)).toBe(true);
        expect(await storage.exists(`${PREFIX}missing`)).toBe(false);

        const meta = await storage.stat(`${PREFIX}a`);
        expect(meta).toMatchObject({ key: `${PREFIX}a`, size: 5, contentType: 'text/plain' });

        // Upsert overwrites.
        await storage.write(`${PREFIX}a`, 'world');
        expect(await text(`${PREFIX}a`)).toBe('world');
    });

    it('throws StorageObjectNotFoundError reading a missing key', async () => {
        if (!available || !db) return;
        await expect(storage.read(`${PREFIX}nope`)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it('deletes idempotently and lists by prefix', async () => {
        if (!available || !db) return;
        await db.deleteFrom('storageObjects').where('key', 'like', `${PREFIX}%`).execute();
        await storage.write(`${PREFIX}x`, 'x');
        await storage.write(`${PREFIX}y`, 'y');

        const listed = await storage.list({ prefix: PREFIX });
        expect(listed.objects.map(o => o.key).sort()).toEqual([`${PREFIX}x`, `${PREFIX}y`]);

        await storage.delete(`${PREFIX}x`);
        await storage.delete(`${PREFIX}x`); // no-op second time
        expect(await storage.exists(`${PREFIX}x`)).toBe(false);
    });
});
