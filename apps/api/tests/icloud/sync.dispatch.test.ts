import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { Duration } from 'luxon';
import { describe, expect, it } from 'vitest';
import { SyncRegistry } from '../../src/modules/icloud/sync/sync.registry.js';
import { SYNC_PHOTOS_JOB } from '../../src/modules/icloud/sync/sync.photos.job.js';
import { SweepPhotosJob, dispatchSync, enqueueSync } from '../../src/modules/icloud/sync/sync.dispatch.js';

interface SendOptions {
    startAfter?: Duration;
}

/** Records every send (with its enqueue options) and hands back a deterministic id per call. */
class FakeBroker {
    readonly sent: Array<{ name: string; payload: unknown; options?: SendOptions }> = [];
    private seq = 0;
    async send(name: string, payload: object, options?: SendOptions): Promise<string> {
        this.sent.push({ name, payload, options });
        this.seq += 1;
        return `job-${this.seq}`;
    }
}

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

describe('enqueueSync', () => {
    it('enqueues a per-account job and tracks its id', async () => {
        const broker = new FakeBroker();
        const registry = new SyncRegistry();

        const id = await enqueueSync(broker as unknown as JobBroker, registry, ID_A, { batchSize: 10 });

        expect(id).toBe('job-1');
        expect(broker.sent).toEqual([{ name: SYNC_PHOTOS_JOB, payload: { batchSize: 10, accountId: ID_A } }]);
        expect(registry.jobId(ID_A)).toBe('job-1');
    });

    it('always sets the account id, overriding any accountId in the options', async () => {
        const broker = new FakeBroker();
        const registry = new SyncRegistry();

        await enqueueSync(broker as unknown as JobBroker, registry, ID_A, { accountId: ID_B });

        expect(broker.sent[0]!.payload).toEqual({ accountId: ID_A });
    });
});

describe('dispatchSync', () => {
    it('fans out one job per account and tracks them all', async () => {
        const broker = new FakeBroker();
        const registry = new SyncRegistry();

        const queued = await dispatchSync(broker as unknown as JobBroker, registry, [ID_A, ID_B], { metadataOnly: true });

        expect(queued).toEqual([
            { id: ID_A, jobId: 'job-1' },
            { id: ID_B, jobId: 'job-2' },
        ]);
        expect(broker.sent.map(s => s.payload)).toEqual([
            { metadataOnly: true, accountId: ID_A },
            { metadataOnly: true, accountId: ID_B },
        ]);
        expect(registry.accounts().sort()).toEqual([ID_A, ID_B].sort());
    });

    it('staggers successive accounts so they do not all hit iCloud at once', async () => {
        const broker = new FakeBroker();
        const registry = new SyncRegistry();

        await dispatchSync(broker as unknown as JobBroker, registry, [ID_A, ID_B]);

        // First account runs immediately; the second is deferred (15s stagger).
        expect(broker.sent[0]!.options).toBeUndefined();
        expect(broker.sent[1]!.options?.startAfter?.as('seconds')).toBe(15);
    });
});

describe('SweepPhotosJob', () => {
    it('enqueues a per-account sync for every registered account', async () => {
        const broker = new FakeBroker();
        const registry = new SyncRegistry();
        const icloud = {
            listAccounts: async () => [
                { id: ID_A, account: 'a@icloud.com' },
                { id: ID_B, account: 'b@icloud.com' },
            ],
        };
        const job = new SweepPhotosJob(icloud, broker as unknown as JobBroker, registry);

        await job.run();

        expect(broker.sent.map(s => s.name)).toEqual([SYNC_PHOTOS_JOB, SYNC_PHOTOS_JOB]);
        expect(broker.sent.map(s => (s.payload as { accountId: string }).accountId).sort()).toEqual([ID_A, ID_B].sort());
        expect(registry.accounts().sort()).toEqual([ID_A, ID_B].sort());
    });
});
