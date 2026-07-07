/**
 * Paging audit for the iCloud Photos library. Reuses the session persisted by
 * `login:live` and pages the *real* `CPLAssetAndMaster…` index two ways, side by
 * side, to localise why a full sync stops short of the library's asset count:
 *
 *   - "current"  — advances the rank cursor by `masters.length`, exactly what
 *     {@link PhotosService.list} does today.
 *   - "byPageSize" — advances the cursor by the fixed page size (the number of
 *     ranks each request covers), deduping record names across pages.
 *
 * Each page's composition is logged (records / masters / assets / new-unique /
 * duplicates) so an overshoot (cursor jumping past ranks) or a premature empty
 * page shows up directly. If "byPageSize" reaches the count and "current" does
 * not, the cursor-advance is the bug and the fix is confirmed in the same run.
 *
 *   pnpm --filter @icloudsync/icloud photos:audit
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { ICloudClient } from '../src/index.js';

const CONTAINER = 'com.apple.photos.cloud';
const DATABASE_PATH = `/database/1/${CONTAINER}/production/private`;
const DEFAULT_ZONE = 'PrimarySync';
const LIST_INDEX = 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted';

const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 100);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 500);

interface CloudKitRecord {
    recordName: string;
    recordType: string;
}
interface QueryResponse {
    records?: CloudKitRecord[];
    continuationMarker?: unknown;
    [key: string]: unknown;
}

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

    const baseUrl = client.serviceUrl('ckdatabasews');
    if (!baseUrl) {
        console.error('ckdatabasews missing from webservices — session may be stale. Re-run `login:live`.');
        process.exitCode = 1;
        return;
    }

    const photos = client.photos();
    let expected: number | undefined;
    try {
        expected = await photos.getCount();
        console.log(`getCount() (CPLAssetByAssetDateWithoutHiddenOrDeleted): ${expected}`);
    } catch (error) {
        console.error('getCount() failed:', (error as Error).message);
    }
    console.log(`Paging index: ${LIST_INDEX}`);
    console.log(`pageSize=${PAGE_SIZE} → resultsLimit=${PAGE_SIZE * 2}\n`);

    // One page of the real list index at a given rank offset.
    const pageAt = async (offset: number): Promise<QueryResponse> => {
        const path = `${DATABASE_PATH}/records/query?remapEnums=true&getCurrentSyncToken=true`;
        const res = await client.request<QueryResponse>(baseUrl, path, {
            method: 'POST',
            json: {
                query: {
                    recordType: LIST_INDEX,
                    filterBy: [
                        { fieldName: 'startRank', comparator: 'EQUALS', fieldValue: { type: 'INT64', value: offset } },
                        { fieldName: 'direction', comparator: 'EQUALS', fieldValue: { type: 'STRING', value: 'ASCENDING' } },
                    ],
                },
                resultsLimit: PAGE_SIZE * 2,
                zoneID: { zoneName: DEFAULT_ZONE },
            },
        });
        if (res.status !== 200 || res.data === undefined) {
            throw new Error(`records/query failed at startRank=${offset} (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
        }
        return res.data;
    };

    /**
     * Page to exhaustion with a pluggable cursor advance, logging each page.
     * `advance(mastersLen)` returns how far to move `startRank` after a page.
     */
    const run = async (label: string, advance: (mastersLen: number) => number): Promise<void> => {
        console.log(`\n===== strategy: ${label} =====`);
        const seen = new Set<string>();
        let offset = 0;
        let page = 0;
        let dupTotal = 0;
        let sawContinuation = false;

        for (; page < MAX_PAGES; page++) {
            let data: QueryResponse;
            try {
                data = await pageAt(offset);
            } catch (error) {
                console.log(`  page ${page} startRank=${offset}: ERROR ${(error as Error).message}`);
                console.log(`  → stopped by a query error (this would fail the whole sync).`);
                break;
            }
            const records = data.records ?? [];
            const masters = records.filter(r => r.recordType === 'CPLMaster');
            const assets = records.filter(r => r.recordType === 'CPLAsset');
            if (data.continuationMarker !== undefined) sawContinuation = true;

            if (masters.length === 0) {
                console.log(`  page ${page} startRank=${offset}: records=${records.length} masters=0 → STOP (empty page)`);
                break;
            }

            let dup = 0;
            for (const m of masters) {
                if (seen.has(m.recordName)) dup++;
                else seen.add(m.recordName);
            }
            dupTotal += dup;
            console.log(
                `  page ${page} startRank=${offset}: records=${records.length} masters=${masters.length} assets=${assets.length} ` +
                    `newUnique=${masters.length - dup} dup=${dup} cumUnique=${seen.size}`,
            );

            offset += advance(masters.length);
            if (offset < 0) {
                console.log('  → offset went negative; stopping.');
                break;
            }
        }
        if (page >= MAX_PAGES) console.log(`  → hit MAX_PAGES=${MAX_PAGES} safety cap.`);

        const verdict = expected === undefined ? '' : seen.size >= expected ? '  ✅ reached count' : `  ❌ short by ${expected - seen.size}`;
        console.log(`  TOTAL unique=${seen.size} pages=${page} duplicates=${dupTotal} continuationMarker=${sawContinuation}${verdict}`);
    };

    // What the code does today: advance by however many masters came back.
    await run('current (offset += masters.length)', mastersLen => mastersLen);
    // Candidate fix: advance by the ranks each request covers, ignoring duplicate inflation.
    await run('byPageSize (offset += pageSize)', () => PAGE_SIZE);

    console.log('\nDone. Compare the two TOTALs against getCount() above.');
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => rl.close());
