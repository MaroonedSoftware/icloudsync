import { buffer as readStream } from 'node:stream/consumers';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { StorageObjectNotFoundError, StorageProvider } from '@maroonedsoftware/storage';
import type { SessionStore } from '@icloudsync/icloud';

/** Default key prefix under which session blobs live in the storage backend. */
export const DEFAULT_SESSION_PREFIX = 'icloud/sessions/';

/**
 * A `@icloudsync/icloud` {@link SessionStore} that encrypts every blob at rest and
 * delegates the actual byte I/O to a `@maroonedsoftware/storage`
 * {@link StorageProvider} (local disk, S3, or GCS).
 *
 * The session blob (live iCloud cookies + trust token) is sensitive, so bytes
 * are base64-encoded then AES-256-GCM encrypted ({@link EncryptionProvider})
 * before being handed to the backend. Because the backend is abstracted, the
 * same encrypted-session storage works against disk in development and S3/GCS
 * in production with no code change here.
 */
export class EncryptedSessionStore implements SessionStore {
    constructor(
        private readonly storage: StorageProvider,
        private readonly encryption: EncryptionProvider,
        private readonly keyPrefix: string = DEFAULT_SESSION_PREFIX,
    ) {}

    private objectKey(key: string): string {
        return `${this.keyPrefix}${key}`;
    }

    async read(key: string): Promise<Uint8Array | null> {
        let ciphertext: string;
        try {
            const stream = await this.storage.read(this.objectKey(key));
            ciphertext = (await readStream(stream)).toString('utf-8');
        } catch (error) {
            if (error instanceof StorageObjectNotFoundError) return null;
            throw error;
        }
        const base64 = this.encryption.decrypt(ciphertext);
        return new Uint8Array(Buffer.from(base64, 'base64'));
    }

    async write(key: string, data: Uint8Array): Promise<void> {
        const ciphertext = this.encryption.encrypt(Buffer.from(data).toString('base64'));
        await this.storage.write(this.objectKey(key), ciphertext, { contentType: 'application/octet-stream' });
    }

    async remove(key: string): Promise<void> {
        // StorageProvider.delete is idempotent — a missing key is a no-op.
        await this.storage.delete(this.objectKey(key));
    }
}
