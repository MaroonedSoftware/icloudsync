import type { Readable } from 'node:stream';
import { StorageObjectNotFoundError, StorageProvider } from '@maroonedsoftware/storage';

/** Default key prefix for archived photos (empty: keys are `<account>/<record>/<file>`). */
export const DEFAULT_PHOTO_PREFIX = '';

/** Make a filename safe to use as a path segment (no separators, no leading dots). */
function safeName(filename: string | undefined): string | undefined {
    if (!filename) return undefined;
    const cleaned = filename.replace(/[/\\\x00]/g, '_').replace(/^\.+/, '').trim();
    return cleaned.length > 0 ? cleaned : undefined;
}

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
     * The storage key an asset is archived under:
     * `<account>/<group?>/<recordName>/<filename>`, keeping the original name +
     * extension on disk while the unique `recordName` folder prevents collisions
     * between same-named photos. `group` is the (already path-safe) organization
     * folder from the chosen layout — e.g. `2024/2024-03` or an album name —
     * omitted for the flat layout. Falls back to `<recordName>` with no filename.
     */
    key(accountName: string, recordName: string, filename?: string, group?: string): string {
        const name = safeName(filename);
        const leaf = name ? `${recordName}/${name}` : recordName;
        const mid = group ? `${group}/` : '';
        return `${this.prefix}${accountName}/${mid}${leaf}`;
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
