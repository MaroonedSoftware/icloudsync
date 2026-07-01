import { buffer as readStream } from 'node:stream/consumers';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { DiskStorageProvider, DiskStorageProviderOptions, StorageObjectNotFoundError, StorageProvider } from '@maroonedsoftware/storage';
import type { InjectKitRegistry } from 'injectkit';
import { AccountsService } from '../accounts/accounts.service.js';
import { ICloudConfig } from './icloud.config.js';
import { ICloudService } from './icloud.service.js';
import { EncryptedSessionStore } from './storage/encrypted.session.store.js';
import { PhotoArchive } from './storage/photo.archive.js';

/** Storage key the Argon2id salt is persisted under (not secret). */
const SALT_KEY = 'icloud/.encryption-salt';

/**
 * Derive the at-rest {@link EncryptionProvider} from the config secret.
 *
 * Argon2id needs a stable salt to reproduce the key across restarts (otherwise
 * a persisted session can never be decrypted again). The salt comes from
 * `ICLOUD_ENCRYPTION_SALT` when set; otherwise it is auto-managed in the storage
 * backend — read if present, generated and persisted on first run. The salt is
 * not secret, so it is stored unencrypted.
 */
async function deriveEncryption(storage: StorageProvider, config: ICloudConfig): Promise<EncryptionProvider> {
    let salt: Buffer | undefined;
    if (config.encryptionSalt) {
        salt = Buffer.from(config.encryptionSalt, 'hex');
    } else {
        try {
            const stream = await storage.read(SALT_KEY);
            salt = Buffer.from((await readStream(stream)).toString('utf-8'), 'hex');
        } catch (error) {
            if (!(error instanceof StorageObjectNotFoundError)) throw error;
        }
    }

    const persistGeneratedSalt = !config.encryptionSalt && salt === undefined;
    const { key, salt: usedSalt } = await EncryptionProvider.createKey(config.encryptionSecret, salt);

    if (persistGeneratedSalt) {
        await storage.write(SALT_KEY, usedSalt.toString('hex'), { contentType: 'text/plain' });
    }

    return new EncryptionProvider(key);
}

/**
 * Register the iCloud module into an InjectKit registry: the config, the storage
 * backend, the encryption provider, the encrypted session store, and the
 * {@link ICloudService}. Async because key derivation (Argon2id) is async.
 *
 * `storage` holds the encrypted session + salt — pass a
 * {@link PostgresStorageProvider} (the app default) to keep it in the database,
 * or any other {@link StorageProvider}. `photoStorage` holds the backed-up photo
 * bytes and defaults to local disk under `config.photosDir`.
 *
 * ```ts
 * const registry = createRegistry();
 * await registerICloud(registry, config, new PostgresStorageProvider(db));
 * const container = registry.build();
 * const icloud = container.get(ICloudService);
 * ```
 */
export async function registerICloud(
    registry: InjectKitRegistry,
    config: ICloudConfig,
    storage: StorageProvider,
    photoStorage: StorageProvider = new DiskStorageProvider(new DiskStorageProviderOptions({ rootDir: config.photosDir })),
): Promise<void> {
    const encryption = await deriveEncryption(storage, config);
    const store = new EncryptedSessionStore(storage, encryption);

    registry.register(ICloudConfig).useInstance(config);
    registry.register(StorageProvider).useInstance(storage);
    registry.register(EncryptionProvider).useInstance(encryption);
    registry.register(EncryptedSessionStore).useInstance(store);
    registry.register(PhotoArchive).useInstance(new PhotoArchive(photoStorage));
    registry
        .register(ICloudService)
        .useFactory(container => new ICloudService(container.get(EncryptedSessionStore), container.get(AccountsService)))
        .asSingleton();
}
