import { describe, expect, it } from 'vitest';
import { DEFAULT_SYNC_CRON } from '../../src/modules/icloud/sync/sync.defaults.js';

describe('DEFAULT_SYNC_CRON', () => {
    it('is the every-6-hours schedule the settings fallback and sync wiring share', () => {
        // Guards the documented contract: settings.syncCron() and buildPhotoSyncRegistry
        // both fall back to this literal, so a drift here silently reschedules every deployment.
        expect(DEFAULT_SYNC_CRON).toBe('0 */6 * * *');
    });

    it('is a five-field cron expression', () => {
        expect(DEFAULT_SYNC_CRON.trim().split(/\s+/)).toHaveLength(5);
    });
});
