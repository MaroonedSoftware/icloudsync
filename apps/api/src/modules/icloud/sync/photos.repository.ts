import { KyselyRepository } from '@maroonedsoftware/kysely';
import type { PhotoAsset, PhotoResource } from '@icloudsync/icloud';
import { Kysely, sql, type SelectQueryBuilder } from 'kysely';
import type { DB, Json } from '../../data/kysely.js';

/**
 * The persistence surface the photo-sync job depends on. Keeping it an interface
 * (rather than the concrete repository) lets the job be unit-tested against an
 * in-memory fake while production uses {@link PhotosRepository}.
 */
export interface PhotoStore {
    /** Insert-or-update a batch of assets for an account. Returns the row count written. */
    upsertBatch(accountName: string, assets: PhotoAsset[]): Promise<number>;
    /** Map of `recordName → backup_checksum` for assets already backed up to disk (skip set). */
    backedUpChecksums(accountName: string): Promise<Map<string, string | null>>;
    /** Record that an asset's bytes have been archived. */
    markBackedUp(accountName: string, recordName: string, backup: BackupRecord): Promise<void>;
}

/** Details of an archived copy, recorded against the asset row. */
export interface BackupRecord {
    /** Storage key the bytes live under. */
    key: string;
    /** Byte size of the archived copy. */
    size: number;
    /** Checksum of the archived rendition, used to detect changes on re-sync. */
    checksum: string | null;
}

/** A synced photo row as returned to API callers (dates normalised to epoch ms / ISO). */
export interface SyncedPhoto {
    recordName: string;
    masterRecordName: string | null;
    filename: string | null;
    /** Capture date (epoch milliseconds), or null if unknown. */
    assetDate: number | null;
    /** Date added to the library (epoch milliseconds), or null if unknown. */
    addedDate: number | null;
    isFavorite: boolean;
    isHidden: boolean;
    isDeleted: boolean;
    /** Renditions keyed by CloudKit field name (e.g. `resOriginalRes`). */
    resources: Record<string, PhotoResource>;
    /** When this row was last written by a sync (ISO-8601). */
    syncedAt: string;
    /** Storage key of the archived original bytes, or null if not backed up yet. */
    backupKey: string | null;
    /** Byte size of the archived copy, or null. */
    backupSize: number | null;
    /** When the bytes were archived (ISO-8601), or null. */
    backedUpAt: string | null;
}

/** Filters / paging for {@link PhotosRepository.list}. */
export interface ListPhotosOptions {
    /** Max rows to return (caller-clamped). */
    limit: number;
    /** Rows to skip. */
    offset: number;
    /** When set, restrict to favourite (`true`) or non-favourite (`false`) assets. */
    favorite?: boolean;
    /** Include hidden assets (default false). */
    includeHidden?: boolean;
    /** Include deleted assets (default false). */
    includeDeleted?: boolean;
    /** Sort by capture date (default `desc`). */
    order?: 'asc' | 'desc';
}

/** A page of synced photos plus the total matching the same filters. */
export interface ListPhotosResult {
    photos: SyncedPhoto[];
    total: number;
}

/** Aggregate backup stats for an account's synced library. */
export interface PhotoStats {
    /** Total assets known (metadata synced). */
    total: number;
    /** How many are marked favourite. */
    favorites: number;
    /** How many have their bytes archived to storage. */
    backedUp: number;
    /** Total bytes archived to storage. */
    backedUpBytes: number;
    /** Capture date of the newest known asset (epoch ms), or null if empty. */
    newestAssetDate: number | null;
    /** Capture date of the oldest known asset (epoch ms), or null if empty. */
    oldestAssetDate: number | null;
    /** When the most recent row was written by a sync (ISO-8601), or null if empty. */
    lastSyncedAt: string | null;
}

const toBigInt = (value: number | undefined): bigint | null => (value === undefined ? null : BigInt(value));

/**
 * Kysely-backed repository for synced iCloud photos. Upserts are keyed on
 * `(account_name, record_name)` so re-syncing an account is idempotent and
 * reflects metadata changes (favourite/hidden/deleted flags, renditions).
 */
export class PhotosRepository extends KyselyRepository<DB> implements PhotoStore {
    constructor(db: Kysely<DB>) {
        super(db);
    }

    async upsertBatch(accountName: string, assets: PhotoAsset[]): Promise<number> {
        if (assets.length === 0) return 0;

        const rows = assets.map(asset => ({
            accountName,
            recordName: asset.recordName,
            masterRecordName: asset.masterRecordName ?? null,
            filename: asset.filename ?? null,
            assetDate: toBigInt(asset.assetDate),
            addedDate: toBigInt(asset.addedDate),
            isFavorite: asset.isFavorite,
            isHidden: asset.isHidden,
            isDeleted: asset.isDeleted,
            resources: sql<Json>`${JSON.stringify(asset.resources)}::jsonb`,
        }));

        await this.db
            .insertInto('icloudPhotos')
            .values(rows)
            .onConflict(oc =>
                oc.columns(['accountName', 'recordName']).doUpdateSet(eb => ({
                    masterRecordName: eb.ref('excluded.masterRecordName'),
                    filename: eb.ref('excluded.filename'),
                    assetDate: eb.ref('excluded.assetDate'),
                    addedDate: eb.ref('excluded.addedDate'),
                    isFavorite: eb.ref('excluded.isFavorite'),
                    isHidden: eb.ref('excluded.isHidden'),
                    isDeleted: eb.ref('excluded.isDeleted'),
                    resources: eb.ref('excluded.resources'),
                    syncedAt: sql`now()`,
                })),
            )
            .execute();

        return rows.length;
    }

    async backedUpChecksums(accountName: string): Promise<Map<string, string | null>> {
        const rows = await this.db
            .selectFrom('icloudPhotos')
            .select(['recordName', 'backupChecksum'])
            .where('accountName', '=', accountName)
            .where('backedUpAt', 'is not', null)
            .execute();
        return new Map(rows.map(r => [r.recordName, r.backupChecksum]));
    }

    async markBackedUp(accountName: string, recordName: string, backup: BackupRecord): Promise<void> {
        await this.db
            .updateTable('icloudPhotos')
            .set({ backupKey: backup.key, backupSize: BigInt(backup.size), backupChecksum: backup.checksum, backedUpAt: sql`now()` })
            .where('accountName', '=', accountName)
            .where('recordName', '=', recordName)
            .execute();
    }

    /** Apply the shared `(account, favourite, hidden, deleted)` filters to a query. */
    private applyFilters<O>(
        qb: SelectQueryBuilder<DB, 'icloudPhotos', O>,
        accountName: string,
        options: Pick<ListPhotosOptions, 'favorite' | 'includeHidden' | 'includeDeleted'>,
    ): SelectQueryBuilder<DB, 'icloudPhotos', O> {
        let query = qb.where('accountName', '=', accountName);
        if (options.favorite !== undefined) query = query.where('isFavorite', '=', options.favorite);
        if (!options.includeHidden) query = query.where('isHidden', '=', false);
        if (!options.includeDeleted) query = query.where('isDeleted', '=', false);
        return query;
    }

    /** A page of synced photos for an account, with the total matching the same filters. */
    async list(accountName: string, options: ListPhotosOptions): Promise<ListPhotosResult> {
        const totalRow = await this.applyFilters(this.db.selectFrom('icloudPhotos'), accountName, options)
            .select(eb => eb.fn.countAll().as('count'))
            .executeTakeFirst();

        const rows = await this.applyFilters(this.db.selectFrom('icloudPhotos'), accountName, options)
            .selectAll()
            .orderBy('assetDate', options.order === 'asc' ? 'asc' : 'desc')
            .orderBy('recordName', 'asc')
            .limit(options.limit)
            .offset(options.offset)
            .execute();

        return { photos: rows.map(toSyncedPhoto), total: Number(totalRow?.count ?? 0) };
    }

    /** A single synced photo by record name, or null if this account has not synced it. */
    async get(accountName: string, recordName: string): Promise<SyncedPhoto | null> {
        const row = await this.db
            .selectFrom('icloudPhotos')
            .selectAll()
            .where('accountName', '=', accountName)
            .where('recordName', '=', recordName)
            .executeTakeFirst();
        return row ? toSyncedPhoto(row) : null;
    }

    /** Aggregate backup stats for an account (one round-trip). */
    async stats(accountName: string): Promise<PhotoStats> {
        const row = await this.db
            .selectFrom('icloudPhotos')
            .where('accountName', '=', accountName)
            .select(eb => [
                eb.fn.countAll().as('total'),
                eb.fn.countAll().filterWhere('isFavorite', '=', true).as('favorites'),
                eb.fn.countAll().filterWhere('backedUpAt', 'is not', null).as('backedUp'),
                eb.fn.sum('backupSize').as('backedUpBytes'),
                eb.fn.max('assetDate').as('newest'),
                eb.fn.min('assetDate').as('oldest'),
                eb.fn.max('syncedAt').as('lastSynced'),
            ])
            .executeTakeFirst();

        return {
            total: Number(row?.total ?? 0),
            favorites: Number(row?.favorites ?? 0),
            backedUp: Number(row?.backedUp ?? 0),
            backedUpBytes: Number(row?.backedUpBytes ?? 0),
            newestAssetDate: row?.newest == null ? null : Number(row.newest),
            oldestAssetDate: row?.oldest == null ? null : Number(row.oldest),
            lastSyncedAt: row?.lastSynced ? row.lastSynced.toISO() : null,
        };
    }
}

/** Map a raw `icloud_photos` row to the normalised {@link SyncedPhoto} shape. */
function toSyncedPhoto(row: {
    recordName: string;
    masterRecordName: string | null;
    filename: string | null;
    assetDate: bigint | null;
    addedDate: bigint | null;
    isFavorite: boolean;
    isHidden: boolean;
    isDeleted: boolean;
    resources: Json;
    syncedAt: { toISO(): string | null };
    backupKey: string | null;
    backupSize: bigint | null;
    backedUpAt: { toISO(): string | null } | null;
}): SyncedPhoto {
    return {
        recordName: row.recordName,
        masterRecordName: row.masterRecordName,
        filename: row.filename,
        assetDate: row.assetDate === null ? null : Number(row.assetDate),
        addedDate: row.addedDate === null ? null : Number(row.addedDate),
        isFavorite: row.isFavorite,
        isHidden: row.isHidden,
        isDeleted: row.isDeleted,
        resources: (row.resources ?? {}) as unknown as Record<string, PhotoResource>,
        syncedAt: row.syncedAt.toISO() ?? '',
        backupKey: row.backupKey,
        backupSize: row.backupSize === null ? null : Number(row.backupSize),
        backedUpAt: row.backedUpAt ? row.backedUpAt.toISO() : null,
    };
}
