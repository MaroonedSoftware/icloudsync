import { describe, expect, it } from 'vitest';
import { DEFAULT_SYNC_CRON, SYNC_QUEUE_POLICY, buildPhotoSyncRegistry } from '../../src/modules/icloud/sync/photo.sync.module.js';
import { SYNC_PHOTOS_JOB, SyncPhotosJob } from '../../src/modules/icloud/sync/sync.photos.job.js';
import { SYNC_SWEEP_JOB, SweepPhotosJob } from '../../src/modules/icloud/sync/sync.dispatch.js';
import { RELOCATE_ARCHIVE_JOB, RelocateArchiveJob } from '../../src/modules/icloud/sync/relocate.archive.job.js';

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
