import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { Kysely, sql } from 'kysely';
import type { SessionStore } from '@icloudsync/icloud';
import type { DB } from '../../data/kysely.js';

/**
 * A `@icloudsync/icloud` {@link SessionStore} bound to a single account, backing
 * the session onto the `session` column of that account's `icloud_accounts` row
 * (rather than a separate blob store). One instance is created per account by
 * {@link ICloudService}, so the `key` the client passes is ignored — the row is
 * already pinned by {@link accountId}.
 *
 * The session blob (live iCloud cookies + trust token) is sensitive, so bytes
 * are base64-encoded then AES-256-GCM encrypted ({@link EncryptionProvider})
 * before being written; the ciphertext string is stored as-is in the `bytea`
 * column and decrypted on read. `read` returns `null` when the column is unset
 * (no session persisted yet), which the client treats as "log in fresh".
 */
export class AccountSessionStore implements SessionStore {
    constructor(
        private readonly db: Kysely<DB>,
        private readonly encryption: EncryptionProvider,
        private readonly accountId: string,
    ) {}

    async read(_key: string): Promise<Uint8Array | null> {
        const row = await this.db.selectFrom('icloudAccounts').select('session').where('id', '=', this.accountId).executeTakeFirst();
        const blob = row?.session;
        if (!blob) return null;
        const base64 = this.encryption.decrypt(Buffer.from(blob).toString('utf-8'));
        return new Uint8Array(Buffer.from(base64, 'base64'));
    }

    async write(_key: string, data: Uint8Array): Promise<void> {
        const ciphertext = this.encryption.encrypt(Buffer.from(data).toString('base64'));
        await this.db
            .updateTable('icloudAccounts')
            .set({ session: Buffer.from(ciphertext, 'utf-8'), sessionUpdatedAt: sql`now()` })
            .where('id', '=', this.accountId)
            .execute();
    }

    async remove(_key: string): Promise<void> {
        await this.db
            .updateTable('icloudAccounts')
            .set({ session: null, sessionUpdatedAt: sql`now()` })
            .where('id', '=', this.accountId)
            .execute();
    }
}
