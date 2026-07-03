import type { Readable } from 'node:stream';
import { StorageObjectNotFoundError, StorageProvider } from '@maroonedsoftware/storage';

/** Default key prefix for archived photos (empty: keys are `<accountPrefix>/<group?>/<file>`). */
export const DEFAULT_PHOTO_PREFIX = '';

/**
 * Durable store for the actual photo *bytes* (the backup), as opposed to the
 * metadata mirror in Postgres. Delegates byte I/O to a `@maroonedsoftware/storage`
 * {@link StorageProvider} — local disk by default, or S3/GCS for an off-box
 * backup, with no change to the sync job or download proxy.
 *
 * Bytes are stored as-is (no encryption): unlike the session blob, a personal
 * photo archive doesn't warrant the size/CPU cost, and disk/bucket-level
 * encryption is the right layer for that.
 */
export class PhotoArchive {
    constructor(
        private readonly storage: StorageProvider,
        private readonly prefix: string = DEFAULT_PHOTO_PREFIX,
    ) {}

    /**
     * The storage key an asset is archived under: `<accountPrefix>/<group?>/<leaf>`,
     * where `accountPrefix` is the account's archive prefix (its custom
     * `archive_prefix`, else its id), `leaf` is the already-composed, path-safe
     * filename from the chosen naming scheme (see {@link namingLeaf}) and `group`
     * is the (already path-safe) organization folder from the chosen layout — e.g.
     * `2024/2024-03` or an album name — omitted for the flat layout. All parts are
     * sanitized by their producers, so this only joins them under the base prefix.
     */
    key(accountPrefix: string, leaf: string, group?: string): string {
        const mid = group ? `${group}/` : '';
        return `${this.prefix}${accountPrefix}/${mid}${leaf}`;
    }

    /**
     * Re-root a stored `key` from one account prefix folder to another (under the
     * same base prefix), preserving the group/leaf tail. Returns `null` when the
     * key does not live under `fromAccountPrefix` (so it should be left alone).
     * Used when an account's `archive_prefix` changes and its existing files are
     * relocated (see {@link move}).
     */
    reprefix(key: string, fromAccountPrefix: string, toAccountPrefix: string): string | null {
        const from = `${this.prefix}${fromAccountPrefix}/`;
        if (!key.startsWith(from)) return null;
        return `${this.prefix}${toAccountPrefix}/${key.slice(from.length)}`;
    }

    /**
     * Move an archived object from `fromKey` to `toKey`. Idempotent for a resumed
     * relocation: a missing source is treated as already moved (a prior partial
     * run relocated it), so re-running to finish an interrupted relocation is safe.
     */
    async move(fromKey: string, toKey: string): Promise<void> {
        if (fromKey === toKey) return;
        try {
            await this.storage.move(fromKey, toKey);
        } catch (error) {
            if (!(error instanceof StorageObjectNotFoundError)) throw error;
            // Source already gone — assume a prior partial relocation moved it.
        }
    }

    /** Write the asset bytes, returning the byte count stored. */
    async store(key: string, bytes: Uint8Array, contentType?: string): Promise<number> {
        await this.storage.write(key, Buffer.from(bytes), contentType ? { contentType } : undefined);
        return bytes.byteLength;
    }

    /** Whether an archived copy exists at `key`. */
    exists(key: string): Promise<boolean> {
        return this.storage.exists(key);
    }

    /** Open a readable stream of the archived bytes (for the download proxy). */
    read(key: string): Promise<Readable> {
        return this.storage.read(key);
    }

    /** Remove an archived copy. Missing keys are treated as already gone. */
    async remove(key: string): Promise<void> {
        try {
            await this.storage.delete(key);
        } catch (error) {
            if (!(error instanceof StorageObjectNotFoundError)) throw error;
        }
    }
}
