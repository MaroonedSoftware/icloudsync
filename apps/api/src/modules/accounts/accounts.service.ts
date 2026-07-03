import { Kysely } from 'kysely';
import type { DB } from '../data/kysely.js';
import type { PhotoLayout } from '../icloud/storage/photo.layout.js';
import type { PhotoNaming } from '../icloud/storage/photo.naming.js';

/**
 * An account's on-disk organization overrides. Each field is `null` when the
 * account inherits the global default (the `photos_layout` / `photos_naming`
 * settings) rather than pinning its own.
 */
export interface AccountPhotoSettings {
    /** Layout override, or `null` to inherit the global default. */
    layout: PhotoLayout | null;
    /** Naming override, or `null` to inherit the global default. */
    naming: PhotoNaming | null;
}

/**
 * A registered account's identity and storage config, as stored in
 * `icloud_accounts`. The {@link id} (an auto-generated UUID) is the stable
 * internal identity used everywhere (URLs, foreign keys, storage prefixes); the
 * {@link accountName} (Apple ID email) is the iCloud login. The session blob and
 * layout/naming overrides live on the same row but are read via their own
 * accessors ({@link AccountSessionStore}, {@link photoSettings}).
 */
export interface Account {
    /** Auto-generated UUID primary key — the account's internal identity. */
    id: string;
    /** Apple ID email (the iCloud login); unique across accounts. */
    accountName: string;
    /** Custom photo-archive path prefix, or `null` to use the account id. */
    archivePrefix: string | null;
    /** Summary of the last archive-relocation failure, or `null` if the last move succeeded (or none ran). */
    relocationError: string | null;
    /** Prefix a failed relocation should resume moving from, or `null` if there is nothing to resume. */
    relocationFrom: string | null;
}

/**
 * The registry of iCloud accounts this instance backs up, persisted in the
 * `icloud_accounts` table. It is the source of truth for which accounts exist —
 * the sync job loops over {@link list} to back up every account, and the UI
 * lists/switches between them. An account is registered on its first login
 * ({@link create}, idempotent) and removed only when explicitly deleted
 * ({@link remove}, which cascades to its photos and session). Accounts are keyed
 * by their UUID {@link Account.id}; the Apple ID email is a unique attribute.
 *
 * Each account may also override the global on-disk organization
 * ({@link photoSettings} / {@link setPhotoSettings}); an unset override inherits
 * the global default.
 */
export class AccountsService {
    constructor(private readonly db: Kysely<DB>) {}

    /** All registered accounts, oldest first (stable order for the UI switcher). */
    async list(): Promise<Account[]> {
        return this.db
            .selectFrom('icloudAccounts')
            .select(['id', 'accountName', 'archivePrefix', 'relocationError', 'relocationFrom'])
            .orderBy('addedAt', 'asc')
            .orderBy('accountName', 'asc')
            .execute();
    }

    /**
     * Register `accountName` if it is new, returning its id either way
     * (idempotent). The no-op `onConflict` update lets the existing row's id be
     * returned when the account is already registered.
     */
    async create(accountName: string): Promise<string> {
        const row = await this.db
            .insertInto('icloudAccounts')
            .values({ accountName })
            .onConflict(oc => oc.column('accountName').doUpdateSet({ accountName }))
            .returning('id')
            .executeTakeFirstOrThrow();
        return row.id;
    }

    /** The account with this id, or `undefined` if none is registered. */
    async getById(id: string): Promise<Account | undefined> {
        return this.db.selectFrom('icloudAccounts').select(['id', 'accountName', 'archivePrefix', 'relocationError', 'relocationFrom']).where('id', '=', id).executeTakeFirst();
    }

    /** The account with this Apple ID email, or `undefined` if none is registered. */
    async getByName(accountName: string): Promise<Account | undefined> {
        return this.db
            .selectFrom('icloudAccounts')
            .select(['id', 'accountName', 'archivePrefix', 'relocationError', 'relocationFrom'])
            .where('accountName', '=', accountName)
            .executeTakeFirst();
    }

    /** Unregister an account (cascades to its photos). A no-op if it was not registered. */
    async remove(id: string): Promise<void> {
        await this.db.deleteFrom('icloudAccounts').where('id', '=', id).execute();
    }

    /** Whether an account with this id is registered. */
    async has(id: string): Promise<boolean> {
        const row = await this.db.selectFrom('icloudAccounts').select('id').where('id', '=', id).executeTakeFirst();
        return row !== undefined;
    }

    /**
     * An account's layout/naming overrides. Each field is `null` when the account
     * inherits the global default; an unknown account also reads as all-null.
     */
    async photoSettings(id: string): Promise<AccountPhotoSettings> {
        const row = await this.db
            .selectFrom('icloudAccounts')
            .select(['photosLayout', 'photosNaming'])
            .where('id', '=', id)
            .executeTakeFirst();
        return {
            layout: (row?.photosLayout ?? null) as PhotoLayout | null,
            naming: (row?.photosNaming ?? null) as PhotoNaming | null,
        };
    }

    /**
     * Set (or clear) an account's overrides. Only the keys present in `patch` are
     * touched; pass `null` to clear an override back to inheriting the default. A
     * no-op when `patch` is empty.
     */
    async setPhotoSettings(id: string, patch: Partial<AccountPhotoSettings>): Promise<void> {
        const set: { photosLayout?: string | null; photosNaming?: string | null } = {};
        if ('layout' in patch) set.photosLayout = patch.layout ?? null;
        if ('naming' in patch) set.photosNaming = patch.naming ?? null;
        if (Object.keys(set).length === 0) return;
        await this.db.updateTable('icloudAccounts').set(set).where('id', '=', id).execute();
    }

    /**
     * Set (or clear) an account's custom photo-archive path prefix. Pass `null`
     * to clear it back to the default (the account id is used as the prefix).
     */
    async setArchivePrefix(id: string, archivePrefix: string | null): Promise<void> {
        await this.db.updateTable('icloudAccounts').set({ archivePrefix }).where('id', '=', id).execute();
    }

    /**
     * Record the outcome of the account's last archive relocation in one write:
     * `error` is a failure summary to surface (or `null` when it succeeded / a
     * fresh move started), and `resumeFrom` is the prefix a failed move should be
     * resumed from (or `null` when there is nothing left to move).
     */
    async setRelocationState(id: string, error: string | null, resumeFrom: string | null): Promise<void> {
        await this.db.updateTable('icloudAccounts').set({ relocationError: error, relocationFrom: resumeFrom }).where('id', '=', id).execute();
    }
}
