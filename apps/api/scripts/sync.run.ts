/**
 * One-shot Photos -> Postgres sync against a real account. Reuses the session
 * persisted by `@icloudsync/icloud`'s `login:live` (plain FileStorage under
 * ~/.icloudsync) and the local Postgres, invoking the sync job directly (no
 * pg-boss). Prints how many rows landed in `icloud_photos`.
 *
 *   pnpm --filter @icloudsync/api sync:run
 *
 * Requires: `login:live` completed once, and DATABASE_URL (defaults to the
 * local dev DB) pointing at a migrated database.
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ICloudClient } from '@icloudsync/icloud';
import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { DiskStorageProvider, DiskStorageProviderOptions } from '@maroonedsoftware/storage';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '../src/modules/data/kysely.js';
import { PhotoArchive } from '../src/modules/icloud/storage/photo.archive.js';
import { PhotosRepository } from '../src/modules/icloud/sync/photos.repository.js';
import { SyncPhotosJob, type PhotoSyncSource } from '../src/modules/icloud/sync/sync.photos.job.js';
import { SettingsService } from '../src/modules/settings/settings.service.js';

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q: string): Promise<string> => (await rl.question(q)).trim();

const countRows = async (db: Kysely<DB>, account: string): Promise<number> => {
    const row = await db.selectFrom('icloudPhotos').select(db.fn.countAll().as('n')).where('accountName', '=', account).executeTakeFirst();
    return Number(row?.n ?? 0);
};

async function main(): Promise<void> {
    const accountName = process.env.APPLE_ID ?? (await ask('Apple ID: '));
    const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/icloudsync?sslmode=disable';

    const pool = new KyselyPool({ connectionString, types: KyselyPgTypeOverrides });
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: KyselyDefaultPlugins });

    try {
        const client = new ICloudClient({ accountName, debug: Boolean(process.env.ICLOUD_DEBUG) });
        // Single-account harness: expose just this one account to the multi-account job.
        const source: PhotoSyncSource = {
            listAccounts: () => Promise.resolve([accountName]),
            isAuthenticated: () => client.isAuthenticated,
            restoreAccount: () => client.restore(),
            photos: (_account, zone) => client.photos(zone),
            download: (_account, url) => client.download(url),
        };

        const photosDir = process.env.ICLOUD_PHOTOS_DIR ?? path.join(homedir(), '.icloudsync', 'photos');
        const archive = new PhotoArchive(new DiskStorageProvider(new DiskStorageProviderOptions({ rootDir: photosDir })));

        const before = await countRows(db, accountName);
        console.log(`rows for ${accountName} before: ${before}`);

        const startedAt = Date.now();
        const job = new SyncPhotosJob(source, new PhotosRepository(db), archive, new ConsoleLogger(), new SettingsService(db));
        await job.run({ pageSize: 100, batchSize: 200 });
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

        const after = await countRows(db, accountName);
        console.log(`\nrows for ${accountName} after:  ${after}  (+${after - before} in ${elapsed}s)`);
    } finally {
        await db.destroy();
    }
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => rl.close());
