/**
 * Manual Photos/CloudKit probe. Reuses the session persisted by `login:live`
 * (no re-login) and exercises the real ckdatabasews API: count, list, and the
 * asset/master pairing + filename decoding.
 *
 *   pnpm --filter @icloudsync/icloud photos:probe
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { ICloudClient } from '../src/index.js';

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q: string): Promise<string> => (await rl.question(q)).trim();

async function main(): Promise<void> {
    const accountName = process.env.APPLE_ID ?? (await ask('Apple ID: '));
    const client = new ICloudClient({ accountName, debug: Boolean(process.env.ICLOUD_DEBUG) });

    if (!(await client.restore())) {
        console.error('No saved session found. Run `login:live` first.');
        process.exitCode = 1;
        return;
    }

    console.log('dsid:', client.dsid);
    console.log('ckdatabasews:', client.serviceUrl('ckdatabasews'));

    const photos = client.photos();

    try {
        console.log('\nTotal photo count:', await photos.getCount());
    } catch (error) {
        console.error('getCount() failed:', (error as Error).message);
    }

    console.log('\nFirst few assets (oldest first):');
    let n = 0;
    for await (const asset of photos.list({ pageSize: 5 })) {
        const renditions = Object.keys(asset.resources).join(', ');
        console.log(`  ${(asset.filename ?? '(no name)').padEnd(28)} date=${asset.assetDate}  fav=${asset.isFavorite}  renditions=[${renditions}]`);
        if (++n >= 5) break;
    }
    if (n === 0) console.log('  (no assets returned)');
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => rl.close());
