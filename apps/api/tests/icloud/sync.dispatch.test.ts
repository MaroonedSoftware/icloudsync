import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { describe, expect, it } from 'vitest';
import { SyncRegistry } from '../../src/modules/icloud/sync/sync.registry.js';
import { SYNC_PHOTOS_JOB } from '../../src/modules/icloud/sync/sync.photos.job.js';
import { SweepPhotosJob, dispatchSync, enqueueSync } from '../../src/modules/icloud/sync/sync.dispatch.js';

/** Records every send and hands back a deterministic id per call. */
class FakeBroker {
    readonly sent: Array<{ name: string; payload: unknown }> = [];
    private seq = 0;
    async send(name: string, payload: object): Promise<string> {
        this.sent.push({ name, payload });
        this.seq += 1;
        return `job-${this.seq}`;
    }
}

describe('enqueueSync', () => {
    it('enqueues a per-account job and tracks its id', async () => {
        const broker = new FakeBroker();
        const registry = new SyncRegistry();

        const id = await enqueueSync(broker as unknown as JobBroker, registry, 'me@icloud.com', { batchSize: 10 });

        expect(id).toBe('job-1');
        expect(broker.sent).toEqual([{ name: SYNC_PHOTOS_JOB, payload: { batchSize: 10, accountName: 'me@icloud.com' } }]);
        expect(registry.jobId('me@icloud.com')).toBe('job-1');
    });

    it('always sets the account, overriding any accountName in the options', async () => {
        const broker = new FakeBroker();
        const registry = new SyncRegistry();

        await enqueueSync(broker as unknown as JobBroker, registry, 'me@icloud.com', { accountName: 'other@icloud.com' });

        expect(broker.sent[0]!.payload).toEqual({ accountName: 'me@icloud.com' });
    });
});

describe('dispatchSync', () => {
    it('fans out one job per account and tracks them all', async () => {
        const broker = new FakeBroker();
        const registry = new SyncRegistry();

        const queued = await dispatchSync(broker as unknown as JobBroker, registry, ['a@icloud.com', 'b@icloud.com'], { metadataOnly: true });

        expect(queued).toEqual([
            { account: 'a@icloud.com', jobId: 'job-1' },
            { account: 'b@icloud.com', jobId: 'job-2' },
        ]);
        expect(broker.sent.map(s => s.payload)).toEqual([
            { metadataOnly: true, accountName: 'a@icloud.com' },
            { metadataOnly: true, accountName: 'b@icloud.com' },
        ]);
        expect(registry.accounts().sort()).toEqual(['a@icloud.com', 'b@icloud.com']);
    });
});

describe('SweepPhotosJob', () => {
    it('enqueues a per-account sync for every registered account', async () => {
        const broker = new FakeBroker();
        const registry = new SyncRegistry();
        const icloud = { listAccounts: async () => ['a@icloud.com', 'b@icloud.com'] };
        const job = new SweepPhotosJob(icloud, broker as unknown as JobBroker, registry);

        await job.run();

        expect(broker.sent.map(s => s.name)).toEqual([SYNC_PHOTOS_JOB, SYNC_PHOTOS_JOB]);
        expect(registry.accounts().sort()).toEqual(['a@icloud.com', 'b@icloud.com']);
    });
});
