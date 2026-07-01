import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DiskStorageProvider, DiskStorageProviderOptions } from '@maroonedsoftware/storage';
import { createRegistry } from 'injectkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../src/modules/accounts/accounts.service.js';
import { ICloudConfig } from '../../src/modules/icloud/icloud.config.js';
import { ICloudService } from '../../src/modules/icloud/icloud.service.js';
import { registerICloud } from '../../src/modules/icloud/icloud.module.js';
import { EncryptedSessionStore } from '../../src/modules/icloud/storage/encrypted.session.store.js';

/** ICloudService resolves AccountsService for the account registry; a stub suffices here. */
const stubAccounts = { list: async () => [] } as unknown as AccountsService;

describe('registerICloud', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'icloud-module-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    function config(): ICloudConfig {
        return new ICloudConfig({ encryptionSecret: 'a-test-passphrase-1234' });
    }
    /** A disk-backed session store rooted at the temp dir (the registerICloud `storage` arg). */
    const diskStorage = () => new DiskStorageProvider(new DiskStorageProviderOptions({ rootDir: dir }));

    it('wires a singleton ICloudService and auto-persists the encryption salt', async () => {
        const registry = createRegistry();
        registry.register(AccountsService).useInstance(stubAccounts);
        await registerICloud(registry, config(), diskStorage());
        const container = registry.build();

        const service = container.get(ICloudService);
        expect(service).toBeInstanceOf(ICloudService);
        expect(service.isAuthenticated('me@icloud.com')).toBe(false);
        expect(container.get(ICloudService)).toBe(service); // singleton

        // The Argon2id salt was persisted (in the storage backend) for
        // reproducible key derivation across restarts.
        const salt = await readFile(path.join(dir, 'icloud', '.encryption-salt'), 'utf-8');
        expect(salt).toMatch(/^[0-9a-f]+$/);
    });

    it('reuses the persisted salt so a later boot can decrypt the prior session', async () => {
        // First boot writes an encrypted blob.
        const first = createRegistry();
        await registerICloud(first, config(), diskStorage());
        const firstStore = first.build().get(EncryptedSessionStore);
        const blob = new TextEncoder().encode(JSON.stringify({ trustToken: 'persisted' }));
        await firstStore.write('session-me@icloud.com.json', blob);

        // Second boot (fresh registry, same dir) derives the same key from the
        // persisted salt and decrypts what the first boot wrote.
        const second = createRegistry();
        await registerICloud(second, config(), diskStorage());
        const secondStore = second.build().get(EncryptedSessionStore);

        const read = await secondStore.read('session-me@icloud.com.json');
        expect(read).not.toBeNull();
        expect(JSON.parse(new TextDecoder().decode(read!))).toEqual({ trustToken: 'persisted' });
    });
});
