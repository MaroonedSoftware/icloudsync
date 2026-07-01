import { Readable } from 'node:stream';
import { buffer as readStream } from 'node:stream/consumers';
import {
    StorageObjectNotFoundError,
    StorageOperationNotSupportedError,
    StorageProvider,
    type SignedUrlOptions,
    type StorageListOptions,
    type StorageListResult,
    type StorageObjectMetadata,
    type StorageReadOptions,
    type StorageWriteOptions,
} from '@maroonedsoftware/storage';
import { Kysely, sql } from 'kysely';
import type { DB } from './kysely.js';

/** Coerce a write body (stream | buffer | string) to a Buffer. */
async function toBuffer(body: Readable | Buffer | string): Promise<Buffer> {
    if (typeof body === 'string') return Buffer.from(body);
    if (Buffer.isBuffer(body)) return body;
    return readStream(body);
}

/**
 * A `@maroonedsoftware/storage` {@link StorageProvider} backed by a Postgres
 * `storage_objects` table. Lets small, sensitive blobs (the encrypted iCloud
 * session + its salt) live in the database instead of on a mounted volume, so a
 * deployment needs no session filesystem. Not intended for large objects (photo
 * bytes still use disk/S3) — there's no streaming write or real pagination.
 */
export class PostgresStorageProvider extends StorageProvider {
    constructor(private readonly db: Kysely<DB>) {
        super();
    }

    async write(key: string, body: Readable | Buffer | string, options?: StorageWriteOptions): Promise<void> {
        const content = await toBuffer(body);
        const contentType = options?.contentType ?? null;
        await this.db
            .insertInto('storageObjects')
            .values({ key, content, contentType })
            .onConflict(oc => oc.column('key').doUpdateSet({ content, contentType, updatedAt: sql`now()` }))
            .execute();
    }

    /** @throws {StorageObjectNotFoundError} if no object is stored under `key`. */
    async read(key: string, options?: StorageReadOptions): Promise<Readable> {
        const row = await this.db.selectFrom('storageObjects').select('content').where('key', '=', key).executeTakeFirst();
        if (!row) throw new StorageObjectNotFoundError(key);
        const content = row.content;
        const range = options?.range;
        const sliced = range ? content.subarray(range.start, range.end === undefined ? undefined : range.end + 1) : content;
        return Readable.from(sliced);
    }

    /** @throws {StorageObjectNotFoundError} if no object is stored under `key`. */
    async stat(key: string): Promise<StorageObjectMetadata> {
        const row = await this.db
            .selectFrom('storageObjects')
            .select(eb => [eb.fn<number>('length', ['content']).as('size'), 'contentType', 'updatedAt'])
            .where('key', '=', key)
            .executeTakeFirst();
        if (!row) throw new StorageObjectNotFoundError(key);
        return { key, size: Number(row.size), contentType: row.contentType ?? undefined, lastModified: row.updatedAt };
    }

    async exists(key: string): Promise<boolean> {
        const row = await this.db.selectFrom('storageObjects').select('key').where('key', '=', key).executeTakeFirst();
        return row !== undefined;
    }

    async delete(key: string): Promise<void> {
        await this.db.deleteFrom('storageObjects').where('key', '=', key).execute();
    }

    /** @throws {StorageObjectNotFoundError} if no object is stored under `sourceKey`. */
    async copy(sourceKey: string, destinationKey: string): Promise<void> {
        const row = await this.db.selectFrom('storageObjects').select(['content', 'contentType']).where('key', '=', sourceKey).executeTakeFirst();
        if (!row) throw new StorageObjectNotFoundError(sourceKey);
        await this.db
            .insertInto('storageObjects')
            .values({ key: destinationKey, content: row.content, contentType: row.contentType })
            .onConflict(oc => oc.column('key').doUpdateSet({ content: row.content, contentType: row.contentType, updatedAt: sql`now()` }))
            .execute();
    }

    /** @throws {StorageObjectNotFoundError} if no object is stored under `sourceKey`. */
    async move(sourceKey: string, destinationKey: string): Promise<void> {
        await this.copy(sourceKey, destinationKey);
        await this.delete(sourceKey);
    }

    async list(options?: StorageListOptions): Promise<StorageListResult> {
        let query = this.db
            .selectFrom('storageObjects')
            .select(eb => ['key', eb.fn<number>('length', ['content']).as('size'), 'contentType', 'updatedAt'])
            .orderBy('key');
        if (options?.prefix) query = query.where('key', 'like', `${options.prefix}%`);
        if (options?.limit) query = query.limit(options.limit);
        const rows = await query.execute();
        return {
            objects: rows.map(r => ({ key: r.key, size: Number(r.size), contentType: r.contentType ?? undefined, lastModified: r.updatedAt })),
        };
    }

    /**
     * Not supported by this provider — Postgres-backed objects have no
     * addressable URL.
     *
     * @throws {StorageOperationNotSupportedError} always.
     */
    getSignedUrl(_key: string, _options: SignedUrlOptions): Promise<string> {
        throw new StorageOperationNotSupportedError('getSignedUrl');
    }
}
