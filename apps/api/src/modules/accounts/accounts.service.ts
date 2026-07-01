import { Kysely } from 'kysely';
import type { DB } from '../data/kysely.js';

/**
 * The registry of iCloud accounts this instance backs up, persisted in the
 * `icloud_accounts` table. It is the source of truth for which accounts exist —
 * the sync job loops over {@link list} to back up every account, and the UI
 * lists/switches between them. An account is registered on its first login
 * ({@link add}, idempotent) and removed only when explicitly deleted
 * ({@link remove}); its photos and session live under the same account key.
 */
export class AccountsService {
    constructor(private readonly db: Kysely<DB>) {}

    /** All registered Apple IDs, oldest first (stable order for the UI switcher). */
    async list(): Promise<string[]> {
        const rows = await this.db
            .selectFrom('icloudAccounts')
            .select('accountName')
            .orderBy('addedAt', 'asc')
            .orderBy('accountName', 'asc')
            .execute();
        return rows.map(r => r.accountName);
    }

    /** Register an account if not already present (idempotent). */
    async add(accountName: string): Promise<void> {
        await this.db
            .insertInto('icloudAccounts')
            .values({ accountName })
            .onConflict(oc => oc.column('accountName').doNothing())
            .execute();
    }

    /** Unregister an account. A no-op if it was not registered. */
    async remove(accountName: string): Promise<void> {
        await this.db.deleteFrom('icloudAccounts').where('accountName', '=', accountName).execute();
    }

    /** Whether an account is registered. */
    async has(accountName: string): Promise<boolean> {
        const row = await this.db
            .selectFrom('icloudAccounts')
            .select('accountName')
            .where('accountName', '=', accountName)
            .executeTakeFirst();
        return row !== undefined;
    }
}
