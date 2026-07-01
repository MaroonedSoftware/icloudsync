import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import type { PhotoAsset } from '@icloudsync/icloud';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PhotosRepository } from '../../src/modules/icloud/sync/photos.repository.js';
import type { DB } from '../../src/modules/data/kysely.js';

/**
 * Integration test against a live Postgres (the project's local DB). It is
 * self-skipping: if the database is unreachable, the assertions are bypassed so
 * the suite stays green on machines without Postgres.
 */
const CONNECTION = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/icloudsync?sslmode=disable';
const ACCOUNT = 'integration-test@icloud.com';

let db: Kysely<DB> | undefined;
let repo: PhotosRepository;
let available = false;

function asset(id: string, favorite: boolean, filename: string): PhotoAsset {
    return {
        recordName: id,
        masterRecordName: `master-${id}`,
        filename,
        assetDate: 1_700_000_000,
        addedDate: 1_700_000_100,
        isFavorite: favorite,
        isHidden: false,
        isDeleted: false,
        resources: { resOriginalRes: { key: 'resOriginalRes', downloadURL: `https://p-content.icloud.com/${id}`, size: 4096 } },
    };
}

beforeAll(async () => {
    try {
        const pool = new KyselyPool({ connectionString: CONNECTION, types: KyselyPgTypeOverrides });
        db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: KyselyDefaultPlugins });
        await sql`select 1`.execute(db);
        repo = new PhotosRepository(db);
        available = true;
    } catch {
        available = false;
        if (db) await db.destroy();
        db = undefined;
    }
});

afterAll(async () => {
    if (db) {
        await db.deleteFrom('icloudPhotos').where('accountName', '=', ACCOUNT).execute();
        await db.destroy();
    }
});

describe('PhotosRepository (integration)', () => {
    it('upserts photos and updates them idempotently', async () => {
        if (!available || !db) {
            console.warn('[photos.repository.int] skipped — Postgres unreachable');
            return;
        }
        await db.deleteFrom('icloudPhotos').where('accountName', '=', ACCOUNT).execute();

        const written = await repo.upsertBatch(ACCOUNT, [asset('a1', true, 'first.jpg'), asset('a2', false, 'second.heic')]);
        expect(written).toBe(2);

        const rows = await db.selectFrom('icloudPhotos').selectAll().where('accountName', '=', ACCOUNT).orderBy('recordName').execute();
        expect(rows).toHaveLength(2);
        expect(rows[0]!.filename).toBe('first.jpg');
        expect(rows[0]!.isFavorite).toBe(true);
        expect(rows[0]!.assetDate).toBe(1_700_000_000n); // int8 -> BigInt
        expect(rows[0]!.resources).toMatchObject({ resOriginalRes: { downloadURL: 'https://p-content.icloud.com/a1' } });

        // Re-upsert the same record with changed metadata -> update, not duplicate.
        await repo.upsertBatch(ACCOUNT, [asset('a1', false, 'renamed.jpg')]);
        const updated = await db
            .selectFrom('icloudPhotos')
            .selectAll()
            .where('accountName', '=', ACCOUNT)
            .where('recordName', '=', 'a1')
            .executeTakeFirstOrThrow();
        expect(updated.filename).toBe('renamed.jpg');
        expect(updated.isFavorite).toBe(false);

        const count = await db
            .selectFrom('icloudPhotos')
            .select(db.fn.countAll().as('n'))
            .where('accountName', '=', ACCOUNT)
            .executeTakeFirstOrThrow();
        expect(Number(count.n)).toBe(2);
    });

    it('lists and reads back synced photos with normalised dates', async () => {
        if (!available || !db) {
            console.warn('[photos.repository.int] skipped — Postgres unreachable');
            return;
        }
        await db.deleteFrom('icloudPhotos').where('accountName', '=', ACCOUNT).execute();
        await repo.upsertBatch(ACCOUNT, [asset('a1', true, 'first.jpg'), asset('a2', false, 'second.heic')]);

        const page = await repo.list(ACCOUNT, { limit: 10, offset: 0, order: 'asc' });
        expect(page.total).toBe(2);
        expect(page.photos.map(p => p.recordName)).toEqual(['a1', 'a2']);
        // int8 -> number (epoch ms), DateTime -> ISO string, jsonb -> object.
        expect(page.photos[0]!.assetDate).toBe(1_700_000_000);
        expect(typeof page.photos[0]!.syncedAt).toBe('string');
        expect(page.photos[0]!.resources.resOriginalRes!.downloadURL).toBe('https://p-content.icloud.com/a1');

        const favorites = await repo.list(ACCOUNT, { limit: 10, offset: 0, favorite: true });
        expect(favorites.total).toBe(1);
        expect(favorites.photos[0]!.recordName).toBe('a1');

        const one = await repo.get(ACCOUNT, 'a2');
        expect(one?.filename).toBe('second.heic');
        expect(await repo.get(ACCOUNT, 'missing')).toBeNull();
    });

    it('excludes hidden and deleted by default, includes them on request', async () => {
        if (!available || !db) {
            console.warn('[photos.repository.int] skipped — Postgres unreachable');
            return;
        }
        await db.deleteFrom('icloudPhotos').where('accountName', '=', ACCOUNT).execute();
        const hidden = { ...asset('h1', false, 'hidden.jpg'), isHidden: true };
        const deleted = { ...asset('d1', false, 'deleted.jpg'), isDeleted: true };
        await repo.upsertBatch(ACCOUNT, [asset('v1', false, 'visible.jpg'), hidden, deleted]);

        const visible = await repo.list(ACCOUNT, { limit: 10, offset: 0 });
        expect(visible.photos.map(p => p.recordName)).toEqual(['v1']);

        const withHidden = await repo.list(ACCOUNT, { limit: 10, offset: 0, includeHidden: true, includeDeleted: true });
        expect(withHidden.total).toBe(3);
    });

    it('aggregates backup stats', async () => {
        if (!available || !db) {
            console.warn('[photos.repository.int] skipped — Postgres unreachable');
            return;
        }
        await db.deleteFrom('icloudPhotos').where('accountName', '=', ACCOUNT).execute();

        const empty = await repo.stats(ACCOUNT);
        expect(empty).toEqual({
            total: 0,
            favorites: 0,
            backedUp: 0,
            backedUpBytes: 0,
            newestAssetDate: null,
            oldestAssetDate: null,
            lastSyncedAt: null,
        });

        const older = { ...asset('s1', true, 'old.jpg'), assetDate: 1_500_000_000 };
        const newer = { ...asset('s2', false, 'new.jpg'), assetDate: 1_700_000_000 };
        await repo.upsertBatch(ACCOUNT, [older, newer]);

        const stats = await repo.stats(ACCOUNT);
        expect(stats.total).toBe(2);
        expect(stats.favorites).toBe(1);
        expect(stats.backedUp).toBe(0);
        expect(stats.oldestAssetDate).toBe(1_500_000_000);
        expect(stats.newestAssetDate).toBe(1_700_000_000);
        expect(typeof stats.lastSyncedAt).toBe('string');
    });

    it('records and counts backed-up bytes', async () => {
        if (!available || !db) {
            console.warn('[photos.repository.int] skipped — Postgres unreachable');
            return;
        }
        await db.deleteFrom('icloudPhotos').where('accountName', '=', ACCOUNT).execute();
        await repo.upsertBatch(ACCOUNT, [asset('b1', false, 'one.jpg'), asset('b2', false, 'two.jpg')]);

        expect(await repo.backedUpChecksums(ACCOUNT)).toEqual(new Map());

        await repo.markBackedUp(ACCOUNT, 'b1', { key: 'photos/x/b1', size: 1500, checksum: 'sum-b1' });

        const checksums = await repo.backedUpChecksums(ACCOUNT);
        expect(checksums).toEqual(new Map([['b1', 'sum-b1']]));

        const stats = await repo.stats(ACCOUNT);
        expect(stats.backedUp).toBe(1);
        expect(stats.backedUpBytes).toBe(1500);

        const one = await repo.get(ACCOUNT, 'b1');
        expect(one?.backupKey).toBe('photos/x/b1');
        expect(one?.backupSize).toBe(1500);
        expect(typeof one?.backedUpAt).toBe('string');
    });
});
