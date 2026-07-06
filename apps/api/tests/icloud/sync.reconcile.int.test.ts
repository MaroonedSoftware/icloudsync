import { ConsoleLogger } from '@maroonedsoftware/logger';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSyncEngine, type SyncEngine, SYNC_QUEUE_POLICY } from '../../src/modules/icloud/sync/photo.sync.module.js';
import { SYNC_PHOTOS_JOB } from '../../src/modules/icloud/sync/sync.photos.job.js';
import { SyncRegistry } from '../../src/modules/icloud/sync/sync.registry.js';
import { inFlightJobId } from '../../src/modules/icloud/sync/job.status.js';

/**
 * Integration test for re-attaching to an in-flight sync after a restart, run
 * against the project's local Postgres with a real pg-boss engine. It proves the
 * whole loop end to end: a sync enqueued into the durable queue is invisible to a
 * fresh (post-restart) in-memory {@link SyncRegistry} until {@link SyncEngine.reconcileInFlight}
 * repopulates it from pg-boss. Self-skips when the database is unreachable, so the
 * suite stays green without it.
 */
const CONNECTION = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/icloudsync?sslmode=disable';

// A unique account id per run so the assertions never collide with jobs left by
// dev usage or a previous run on the shared dev database.
const ACCOUNT = `reconcile-int-${Date.now()}@icloud.com`;

let engine: SyncEngine | undefined;
let available = false;
const enqueued: string[] = [];

beforeAll(async () => {
    try {
        engine = await startSyncEngine(CONNECTION, new ConsoleLogger());
        available = true;
    } catch {
        available = false;
        if (engine) await engine.stop().catch(() => {});
        engine = undefined;
    }
});

afterAll(async () => {
    if (!engine) return;
    // Remove the jobs this test enqueued so it leaves the dev queue as it found it.
    if (enqueued.length) await engine.broker.deleteJob(SYNC_PHOTOS_JOB, enqueued).catch(() => {});
    await engine.stop().catch(() => {});
});

describe('SyncEngine.reconcileInFlight (integration)', () => {
    it('applies the durability policy to the sync queue', async () => {
        if (!available || !engine) {
            console.warn('[sync.reconcile.int] skipped — Postgres unreachable');
            return;
        }
        // startSyncEngine calls updateQueue(SYNC_PHOTOS_JOB, SYNC_QUEUE_POLICY) on boot;
        // read the persisted policy straight from pg-boss's own queue table.
        const client = new Client({ connectionString: CONNECTION });
        await client.connect();
        try {
            const { rows } = await client.query<{ expire_seconds: number; heartbeat_seconds: number | null; retry_limit: number }>(
                'SELECT expire_seconds, heartbeat_seconds, retry_limit FROM pgboss.queue WHERE name = $1',
                [SYNC_PHOTOS_JOB],
            );
            expect(rows[0]?.expire_seconds).toBe(SYNC_QUEUE_POLICY.expireInSeconds);
            expect(rows[0]?.heartbeat_seconds).toBe(SYNC_QUEUE_POLICY.heartbeatSeconds);
            expect(rows[0]?.retry_limit).toBe(SYNC_QUEUE_POLICY.retryLimit);
        } finally {
            await client.end();
        }
    });

    it('re-tracks a queued sync in a fresh registry, so /stats sees it running again', async () => {
        if (!available || !engine) {
            console.warn('[sync.reconcile.int] skipped — Postgres unreachable');
            return;
        }
        // Enqueue a real sync job (no consumer is running, so it stays `created`).
        const jobId = await engine.broker.send(SYNC_PHOTOS_JOB, { accountId: ACCOUNT });
        enqueued.push(jobId);

        // Simulate a restart: the in-memory registry is empty even though pg-boss
        // still holds the job.
        const registry = new SyncRegistry();
        expect(registry.jobId(ACCOUNT)).toBeUndefined();

        const reattached = await engine.reconcileInFlight(registry);

        expect(reattached).toBeGreaterThanOrEqual(1);
        expect(registry.jobId(ACCOUNT)).toBe(jobId);
        // The reconciled id resolves as genuinely in-flight (what /stats and cancel rely on).
        expect(await inFlightJobId(engine.broker, SYNC_PHOTOS_JOB, jobId)).toBe(jobId);
    });

    it('does not re-track a job that has finished (cancelled/terminal)', async () => {
        if (!available || !engine) {
            console.warn('[sync.reconcile.int] skipped — Postgres unreachable');
            return;
        }
        const account = `${ACCOUNT}.terminal`;
        const jobId = await engine.broker.send(SYNC_PHOTOS_JOB, { accountId: account });
        enqueued.push(jobId);
        // Move it out of an in-flight state before reconciling.
        await engine.broker.cancel(SYNC_PHOTOS_JOB, jobId);

        const registry = new SyncRegistry();
        await engine.reconcileInFlight(registry);

        expect(registry.jobId(account)).toBeUndefined();
    });
});
