import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { Duration } from 'luxon';
import { describe, expect, it } from 'vitest';
import { SyncRegistry } from '../../src/modules/icloud/sync/sync.registry.js';
import { SYNC_PHOTOS_JOB } from '../../src/modules/icloud/sync/sync.photos.job.js';
import { SweepPhotosJob, dispatchSync, enqueueSync, reconcileTrackedSyncs, type InFlightSyncJob } from '../../src/modules/icloud/sync/sync.dispatch.js';

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

describe('reconcileTrackedSyncs', () => {
    const job = (over: Partial<InFlightSyncJob>): InFlightSyncJob => ({ id: 'j', state: 'active', data: { accountId: ID_A }, ...over });

    it('re-tracks a queued-or-running job per account and reports the count', () => {
        const registry = new SyncRegistry();

        const count = reconcileTrackedSyncs(registry, [
            job({ id: 'job-a', state: 'active', data: { accountId: ID_A } }),
            job({ id: 'job-b', state: 'created', data: { accountId: ID_B } }),
        ]);

        expect(count).toBe(2);
        expect(registry.jobId(ID_A)).toBe('job-a');
        expect(registry.jobId(ID_B)).toBe('job-b');
    });

    it('ignores terminal jobs and jobs with no account', () => {
        const registry = new SyncRegistry();

        const count = reconcileTrackedSyncs(registry, [
            job({ id: 'done', state: 'completed', data: { accountId: ID_A } }),
            job({ id: 'gone', state: 'cancelled', data: { accountId: ID_A } }),
            job({ id: 'dead', state: 'failed', data: { accountId: ID_A } }),
            job({ id: 'orphan', state: 'active', data: {} }),
            job({ id: 'nodata', state: 'active', data: null }),
        ]);

        expect(count).toBe(0);
        expect(registry.jobId(ID_A)).toBeUndefined();
        expect(registry.accounts()).toEqual([]);
    });

    it('keeps the most recently enqueued job when an account has several in flight', () => {
        const registry = new SyncRegistry();

        // Deliberately unsorted; the newer createdOn must win regardless of order.
        reconcileTrackedSyncs(registry, [
            job({ id: 'older', state: 'active', createdOn: '2026-07-06T10:00:00.000Z', data: { accountId: ID_A } }),
            job({ id: 'newer', state: 'created', createdOn: '2026-07-06T12:00:00.000Z', data: { accountId: ID_A } }),
        ]);

        expect(registry.jobId(ID_A)).toBe('newer');
    });

    it('treats the retry state as in-flight', () => {
        const registry = new SyncRegistry();

        reconcileTrackedSyncs(registry, [job({ id: 'retrying', state: 'retry', data: { accountId: ID_A } })]);

        expect(registry.jobId(ID_A)).toBe('retrying');
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
