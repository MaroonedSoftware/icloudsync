import { Readable } from 'node:stream';
import { buffer as readStream } from 'node:stream/consumers';
import { StorageObjectNotFoundError, StorageProvider } from '@maroonedsoftware/storage';
import type {
    SignedUrlOptions,
    StorageListOptions,
    StorageListResult,
    StorageObjectMetadata,
    StorageReadOptions,
    StorageWriteOptions,
} from '@maroonedsoftware/storage';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PHOTO_PREFIX, PhotoArchive } from '../../src/modules/icloud/storage/photo.archive.js';

/**
 * In-memory {@link StorageProvider} recording every write (bytes + options) so
 * tests can assert what PhotoArchive handed the backend. Only the methods
 * PhotoArchive exercises are implemented; the rest throw if touched.
 */
class InMemoryStorage extends StorageProvider {
    readonly objects = new Map<string, { body: Buffer; options?: StorageWriteOptions }>();

    async write(key: string, body: Readable | Buffer | string, options?: StorageWriteOptions): Promise<void> {
        const buf = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : await readStream(body);
        this.objects.set(key, { body: buf, options });
    }

    read(key: string, _options?: StorageReadOptions): Promise<Readable> {
        const entry = this.objects.get(key);
        if (!entry) return Promise.reject(new StorageObjectNotFoundError(key));
        return Promise.resolve(Readable.from(entry.body));
    }

    exists(key: string): Promise<boolean> {
        return Promise.resolve(this.objects.has(key));
    }

    delete(key: string): Promise<void> {
        this.objects.delete(key);
        return Promise.resolve();
    }

    stat(_key: string): Promise<StorageObjectMetadata> {
        throw new Error('not implemented');
    }
    copy(_sourceKey: string, _destinationKey: string): Promise<void> {
        throw new Error('not implemented');
    }
    move(sourceKey: string, destinationKey: string): Promise<void> {
        const entry = this.objects.get(sourceKey);
        if (!entry) return Promise.reject(new StorageObjectNotFoundError(sourceKey));
        this.objects.set(destinationKey, entry);
        this.objects.delete(sourceKey);
        return Promise.resolve();
    }
    list(_options?: StorageListOptions): Promise<StorageListResult> {
        throw new Error('not implemented');
    }
    getSignedUrl(_key: string, _options: SignedUrlOptions): Promise<string> {
        throw new Error('not implemented');
    }
}

describe('PhotoArchive', () => {
    describe('key', () => {
        it('composes <account>/<leaf> for the flat layout (no group)', () => {
            const archive = new PhotoArchive(new InMemoryStorage());
            expect(archive.key('me@icloud.com', 'IMG_0001.HEIC')).toBe('me@icloud.com/IMG_0001.HEIC');
        });

        it('inserts the group folder before the leaf when given', () => {
            const archive = new PhotoArchive(new InMemoryStorage());
            expect(archive.key('me@icloud.com', 'IMG_0001.HEIC', '2024/2024-03')).toBe('me@icloud.com/2024/2024-03/IMG_0001.HEIC');
        });

        it('joins the leaf verbatim (sanitization is the naming scheme\'s job)', () => {
            const archive = new PhotoArchive(new InMemoryStorage());
            expect(archive.key('acct', 'IMG_0001~a1b2c3.HEIC', 'Album')).toBe('acct/Album/IMG_0001~a1b2c3.HEIC');
        });

        it('prepends the configured prefix to every key', () => {
            const archive = new PhotoArchive(new InMemoryStorage(), 'backup/');
            expect(archive.key('acct', 'a.jpg')).toBe('backup/acct/a.jpg');
        });

        it('uses an empty default prefix', () => {
            expect(DEFAULT_PHOTO_PREFIX).toBe('');
            const archive = new PhotoArchive(new InMemoryStorage());
            expect(archive.key('acct', 'a.jpg')).toBe('acct/a.jpg');
        });
    });

    describe('reprefix', () => {
        it('re-roots a key from one account prefix to another', () => {
            const archive = new PhotoArchive(new InMemoryStorage());
            expect(archive.reprefix('old-id/2024/a.jpg', 'old-id', 'family')).toBe('family/2024/a.jpg');
        });

        it('honors the configured base prefix', () => {
            const archive = new PhotoArchive(new InMemoryStorage(), 'backup/');
            expect(archive.reprefix('backup/old-id/a.jpg', 'old-id', 'new-id')).toBe('backup/new-id/a.jpg');
        });

        it('returns null when the key is not under the old prefix', () => {
            const archive = new PhotoArchive(new InMemoryStorage());
            expect(archive.reprefix('other/a.jpg', 'old-id', 'family')).toBeNull();
        });
    });

    describe('move', () => {
        it('relocates stored bytes to the new key', async () => {
            const storage = new InMemoryStorage();
            const archive = new PhotoArchive(storage);
            await archive.store('old-id/a.jpg', new Uint8Array([1, 2, 3]));

            await archive.move('old-id/a.jpg', 'family/a.jpg');

            expect(storage.objects.has('old-id/a.jpg')).toBe(false);
            expect(storage.objects.get('family/a.jpg')?.body.equals(Buffer.from([1, 2, 3]))).toBe(true);
        });

        it('treats a missing source as already moved (idempotent resume)', async () => {
            const archive = new PhotoArchive(new InMemoryStorage());
            await expect(archive.move('gone/a.jpg', 'family/a.jpg')).resolves.toBeUndefined();
        });

        it('is a no-op when source and destination are the same key', async () => {
            const storage = new InMemoryStorage();
            const archive = new PhotoArchive(storage);
            await archive.store('acct/a.jpg', new Uint8Array([9]));
            await archive.move('acct/a.jpg', 'acct/a.jpg');
            expect(storage.objects.get('acct/a.jpg')?.body.equals(Buffer.from([9]))).toBe(true);
        });
    });

    describe('store', () => {
        it('writes the bytes and returns the byte count stored', async () => {
            const storage = new InMemoryStorage();
            const archive = new PhotoArchive(storage);
            const bytes = new Uint8Array([1, 2, 3, 4, 5]);

            const written = await archive.store('acct/rec/a.jpg', bytes, 'image/jpeg');

            expect(written).toBe(5);
            const entry = storage.objects.get('acct/rec/a.jpg');
            expect(entry?.body.equals(Buffer.from(bytes))).toBe(true);
            expect(entry?.options).toEqual({ contentType: 'image/jpeg' });
        });

        it('omits write options entirely when no content type is given', async () => {
            const storage = new InMemoryStorage();
            const archive = new PhotoArchive(storage);

            await archive.store('acct/rec/a.bin', new Uint8Array([0]));

            expect(storage.objects.get('acct/rec/a.bin')?.options).toBeUndefined();
        });
    });

    describe('exists', () => {
        it('reports whether an archived copy is present', async () => {
            const storage = new InMemoryStorage();
            const archive = new PhotoArchive(storage);

            expect(await archive.exists('acct/rec/a.jpg')).toBe(false);
            await archive.store('acct/rec/a.jpg', new Uint8Array([1]));
            expect(await archive.exists('acct/rec/a.jpg')).toBe(true);
        });
    });

    describe('read', () => {
        it('round-trips stored bytes back through a readable stream', async () => {
            const storage = new InMemoryStorage();
            const archive = new PhotoArchive(storage);
            const bytes = new Uint8Array([9, 8, 7]);
            const key = archive.key('acct', 'a.jpg');
            await archive.store(key, bytes);

            const stream = await archive.read(key);
            expect((await readStream(stream)).equals(Buffer.from(bytes))).toBe(true);
        });

        it('rejects with StorageObjectNotFoundError for a missing key', async () => {
            const archive = new PhotoArchive(new InMemoryStorage());
            await expect(archive.read('nope')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
        });
    });

    describe('remove', () => {
        it('deletes an archived copy', async () => {
            const storage = new InMemoryStorage();
            const archive = new PhotoArchive(storage);
            await archive.store('acct/rec/a.jpg', new Uint8Array([1]));

            await archive.remove('acct/rec/a.jpg');

            expect(storage.objects.has('acct/rec/a.jpg')).toBe(false);
        });

        it('treats a missing key as already gone (swallows StorageObjectNotFoundError)', async () => {
            const storage = new InMemoryStorage();
            // Force delete to raise not-found so the swallow branch is exercised.
            storage.delete = (key: string) => Promise.reject(new StorageObjectNotFoundError(key));
            const archive = new PhotoArchive(storage);

            await expect(archive.remove('gone')).resolves.toBeUndefined();
        });

        it('propagates non-not-found delete errors', async () => {
            const storage = new InMemoryStorage();
            storage.delete = () => Promise.reject(new Error('permission denied'));
            const archive = new PhotoArchive(storage);

            await expect(archive.remove('x')).rejects.toThrow('permission denied');
        });
    });
});
