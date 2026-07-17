import type { Logger } from '@maroonedsoftware/logger';
import { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_SYNC_CRON,
    PGBOSS_APPLICATION_NAME,
    PGBOSS_POOL_MAX,
    SYNC_QUEUE_POLICY,
    attachPgBossErrorHandler,
    buildPhotoSyncRegistry,
    createPgBoss,
} from '../../src/modules/icloud/sync/photo.sync.module.js';
import { SYNC_PHOTOS_JOB, SyncPhotosJob } from '../../src/modules/icloud/sync/sync.photos.job.js';
import { SYNC_SWEEP_JOB, SweepPhotosJob } from '../../src/modules/icloud/sync/sync.dispatch.js';
import { RELOCATE_ARCHIVE_JOB, RelocateArchiveJob } from '../../src/modules/icloud/sync/relocate.archive.job.js';

function fakeLogger(): Logger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
    return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() } as never;
}

describe('buildPhotoSyncRegistry', () => {
    it('registers the per-account job on-demand (no cron)', () => {
        const registrations = buildPhotoSyncRegistry();

        // On-demand jobs map straight to the class; scheduled ones to a { job, cron } object.
        expect(registrations.get(SYNC_PHOTOS_JOB)).toBe(SyncPhotosJob);
    });

    it('registers the sweep on the given cron schedule', () => {
        const registrations = buildPhotoSyncRegistry('*/5 * * * *');

        expect(registrations.get(SYNC_SWEEP_JOB)).toEqual({ job: SweepPhotosJob, cron: '*/5 * * * *' });
    });

    it('defaults the sweep to DEFAULT_SYNC_CRON when no cron is passed', () => {
        const registrations = buildPhotoSyncRegistry();

        expect(registrations.get(SYNC_SWEEP_JOB)).toEqual({ job: SweepPhotosJob, cron: DEFAULT_SYNC_CRON });
    });

    it('registers the archive-relocation job on-demand (no cron)', () => {
        const registrations = buildPhotoSyncRegistry();

        expect(registrations.get(RELOCATE_ARCHIVE_JOB)).toBe(RelocateArchiveJob);
    });

    it('registers exactly the three sync queues', () => {
        const registrations = buildPhotoSyncRegistry();

        expect([...registrations.keys()].sort()).toEqual([SYNC_PHOTOS_JOB, SYNC_SWEEP_JOB, RELOCATE_ARCHIVE_JOB].sort());
    });
});

describe('SYNC_QUEUE_POLICY', () => {
    it('sets a heartbeat pg-boss will accept (>= 10s)', () => {
        // pg-boss rejects a heartbeat interval below 10 seconds.
        expect(SYNC_QUEUE_POLICY.heartbeatSeconds).toBeGreaterThanOrEqual(10);
    });

    it('detects a dead worker via heartbeat well before the absolute expiry', () => {
        // The heartbeat is the fast path that reclaims a killed worker's job; it must
        // fire long before expireInSeconds (the absolute cap) so resume is prompt.
        expect(SYNC_QUEUE_POLICY.heartbeatSeconds).toBeLessThan(SYNC_QUEUE_POLICY.expireInSeconds);
    });

    it('tolerates more restart/expiry cycles than pg-boss default (2)', () => {
        // Each restart or expiry consumes a retry; the budget must exceed the default.
        expect(SYNC_QUEUE_POLICY.retryLimit).toBeGreaterThan(2);
    });
});

describe('createPgBoss', () => {
    it('constructs a PgBoss engine from a connection string without connecting', () => {
        // The constructor only stores config (it connects on start()), so this is safe
        // to build in a unit test.
        const pgboss = createPgBoss('postgres://user:pass@localhost:5432/db');
        expect(pgboss).toBeInstanceOf(PgBoss);
    });

    it('pins an explicit, identifiable connection budget', () => {
        // These feed the pool config so the app's connection demand is documented and
        // its connections are greppable in pg_stat_activity.
        expect(PGBOSS_POOL_MAX).toBe(10);
        expect(PGBOSS_APPLICATION_NAME).toBe('icloudsync-pgboss');
    });
});

describe('attachPgBossErrorHandler', () => {
    it("swallows pg-boss 'error' events so a background failure cannot crash the process", () => {
        const logger = fakeLogger();
        const pgboss = createPgBoss('postgres://user:pass@localhost:5432/db');
        attachPgBossErrorHandler(pgboss, logger);

        // Without a listener, EventEmitter re-throws an 'error' event as ERR_UNHANDLED_ERROR
        // and takes the process down. The handler must catch it.
        expect(() => pgboss.emit('error', new Error('boom'))).not.toThrow();
    });

    it('logs a transient connectivity blip at WARN, a genuine error at ERROR', () => {
        const logger = fakeLogger();
        const pgboss = createPgBoss('postgres://user:pass@localhost:5432/db');
        attachPgBossErrorHandler(pgboss, logger);

        pgboss.emit('error', new Error('Connection terminated due to connection timeout'));
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();

        const genuine = new Error('relation "job" does not exist');
        pgboss.emit('error', genuine);
        expect(logger.error).toHaveBeenCalledWith('pg-boss background error', genuine);
    });
});
