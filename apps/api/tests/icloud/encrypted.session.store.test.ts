import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { DiskStorageProvider, DiskStorageProviderOptions } from '@maroonedsoftware/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EncryptedSessionStore } from '../../src/modules/icloud/storage/encrypted.session.store.js';

describe('EncryptedSessionStore', () => {
    let dir: string;
    let provider: DiskStorageProvider;
    let store: EncryptedSessionStore;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'icloud-store-'));
        provider = new DiskStorageProvider(new DiskStorageProviderOptions({ rootDir: dir }));
        store = new EncryptedSessionStore(provider, new EncryptionProvider(randomBytes(32)));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('returns null for a missing key', async () => {
        expect(await store.read('session-me@icloud.com.json')).toBeNull();
    });

    it('round-trips bytes and stores them encrypted in the backend', async () => {
        const plaintext = JSON.stringify({ trustToken: 'super-secret-trust-token', cookies: [] });
        const data = new TextEncoder().encode(plaintext);

        await store.write('session.json', data);

        // The object lands under the default `icloud/sessions/` prefix; on disk
        // its bytes are the EncryptionProvider's <iv>:<authTag>:<ciphertext> form
        // and must not leak the plaintext secret.
        const onDisk = await readFile(path.join(dir, 'icloud', 'sessions', 'session.json'), 'utf-8');
        expect(onDisk).not.toContain('super-secret-trust-token');
        expect(onDisk.split(':')).toHaveLength(3);

        const read = await store.read('session.json');
        expect(new TextDecoder().decode(read!)).toBe(plaintext);
    });

    it('removes a key idempotently', async () => {
        await store.write('k', new Uint8Array([1, 2, 3]));
        await store.remove('k');
        expect(await store.read('k')).toBeNull();
        await expect(store.remove('k')).resolves.toBeUndefined();
    });

    it('fails to decrypt with a different key (tamper/wrong-key safety)', async () => {
        await store.write('k', new TextEncoder().encode('hello'));
        const wrongKeyStore = new EncryptedSessionStore(provider, new EncryptionProvider(randomBytes(32)));
        await expect(wrongKeyStore.read('k')).rejects.toThrow();
    });
});
