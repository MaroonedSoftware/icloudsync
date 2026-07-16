import { join } from 'node:path';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import { DiskStorageProvider, DiskStorageProviderOptions, StorageProvider } from '@maroonedsoftware/storage';
import type { InjectKitRegistry } from 'injectkit';
import { Kysely, sql } from 'kysely';
import { AccountsService } from '../accounts/accounts.service.js';
import type { DB, Json } from '../data/kysely.js';
import { ICloudConfig } from './icloud.config.js';
import { ICloudService } from './icloud.service.js';
import { AccountSessionStore } from './storage/account.session.store.js';
import { PhotoArchive } from './storage/photo.archive.js';
import { THUMBNAIL_CACHE_DIR, ThumbnailCache } from './storage/thumbnail.cache.js';

/** `app_settings` key the Argon2id salt is persisted under (not secret). */
const SALT_KEY = 'icloud_encryption_salt';

/** Read the persisted Argon2id salt (hex), or `undefined` if none is stored yet. */
async function readSalt(db: Kysely<DB>): Promise<Buffer | undefined> {
    const row = await db.selectFrom('appSettings').select('value').where('key', '=', SALT_KEY).executeTakeFirst();
    return typeof row?.value === 'string' ? Buffer.from(row.value, 'hex') : undefined;
}

/** Persist the Argon2id salt (hex) under {@link SALT_KEY}. */
async function writeSalt(db: Kysely<DB>, hex: string): Promise<void> {
    const value = sql<Json>`${JSON.stringify(hex)}::jsonb`;
    await db
        .insertInto('appSettings')
        .values({ key: SALT_KEY, value })
        .onConflict(oc => oc.column('key').doUpdateSet({ value, updatedAt: sql`now()` }))
        .execute();
}

/**
 * Derive the at-rest {@link EncryptionProvider} from the config secret.
 *
 * Argon2id needs a stable salt to reproduce the key across restarts (otherwise
 * a persisted session can never be decrypted again). The salt comes from
 * `ICLOUD_ENCRYPTION_SALT` when set; otherwise it is auto-managed in the
 * database (`app_settings`) — read if present, generated and persisted on first
 * run. The salt is not secret, so it is stored unencrypted.
 */
async function deriveEncryption(db: Kysely<DB>, config: ICloudConfig): Promise<EncryptionProvider> {
    let salt: Buffer | undefined;
    if (config.encryptionSalt) salt = Buffer.from(config.encryptionSalt, 'hex');
    else salt = await readSalt(db);

    const persistGeneratedSalt = !config.encryptionSalt && salt === undefined;
    const { key, salt: usedSalt } = await EncryptionProvider.createKey(config.encryptionSecret, salt);

    if (persistGeneratedSalt) await writeSalt(db, usedSalt.toString('hex'));

    return new EncryptionProvider(key);
}

/**
 * Register the iCloud module into an InjectKit registry: the config, the
 * encryption provider, and the {@link ICloudService}. Async because key
 * derivation (Argon2id) is async.
 *
 * The encrypted session lives on each account's `icloud_accounts` row (via
 * {@link AccountSessionStore}), so this only needs the `db`; there is no session
 * filesystem or blob store. `photoStorage` holds the backed-up photo bytes and
 * defaults to local disk under `config.photosDir`; `thumbnailStorage` backs the
 * bounded {@link ThumbnailCache} and defaults to a dedicated subdirectory of it.
 *
 * ```ts
 * const registry = createRegistry();
 * await registerICloud(registry, config, db);
 * const container = registry.build();
 * const icloud = container.get(ICloudService);
 * ```
 */
export async function registerICloud(
    registry: InjectKitRegistry,
    config: ICloudConfig,
    db: Kysely<DB>,
    photoStorage: StorageProvider = new DiskStorageProvider(new DiskStorageProviderOptions({ rootDir: config.photosDir })),
    // The thumbnail cache lives under its own root (a subdirectory of the photos
    // dir) so eviction lists only cached thumbnails, never the durable archive.
    thumbnailStorage: StorageProvider = new DiskStorageProvider(new DiskStorageProviderOptions({ rootDir: join(config.photosDir, THUMBNAIL_CACHE_DIR) })),
): Promise<void> {
    const encryption = await deriveEncryption(db, config);
    const sessionStoreFor = (accountId: string): AccountSessionStore => new AccountSessionStore(db, encryption, accountId);

    registry.register(ICloudConfig).useInstance(config);
    registry.register(StorageProvider).useInstance(photoStorage);
    registry.register(EncryptionProvider).useInstance(encryption);
    registry.register(PhotoArchive).useInstance(new PhotoArchive(photoStorage));
    registry.register(ThumbnailCache).useInstance(new ThumbnailCache(thumbnailStorage, config.thumbnailCacheMaxBytes));
    registry
        .register(ICloudService)
        .useFactory(container => new ICloudService(sessionStoreFor, container.get(AccountsService)))
        .asSingleton();
}
