import { describe, expect, it } from 'vitest';
import { DEFAULT_SYNC_CRON, buildPhotoSyncRegistry } from '../../src/modules/icloud/sync/photo.sync.module.js';
import { SYNC_PHOTOS_JOB, SyncPhotosJob } from '../../src/modules/icloud/sync/sync.photos.job.js';
import { SYNC_SWEEP_JOB, SweepPhotosJob } from '../../src/modules/icloud/sync/sync.dispatch.js';

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

    it('registers exactly the two sync queues', () => {
        const registrations = buildPhotoSyncRegistry();

        expect([...registrations.keys()].sort()).toEqual([SYNC_PHOTOS_JOB, SYNC_SWEEP_JOB].sort());
    });
});
