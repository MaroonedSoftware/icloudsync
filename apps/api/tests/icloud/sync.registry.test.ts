import { describe, expect, it } from 'vitest';
import { SyncRegistry } from '../../src/modules/icloud/sync/sync.registry.js';

describe('SyncRegistry', () => {
    it('has no job id for an untracked account', () => {
        const registry = new SyncRegistry();
        expect(registry.jobId('me@icloud.com')).toBeUndefined();
        expect(registry.accounts()).toEqual([]);
    });

    it('remembers the last job id enqueued for an account', () => {
        const registry = new SyncRegistry();
        registry.track('me@icloud.com', 'job-1');
        expect(registry.jobId('me@icloud.com')).toBe('job-1');
        expect(registry.accounts()).toEqual(['me@icloud.com']);
    });

    it('replaces the tracked id when an account is re-enqueued', () => {
        const registry = new SyncRegistry();
        registry.track('me@icloud.com', 'job-1');
        registry.track('me@icloud.com', 'job-2');
        expect(registry.jobId('me@icloud.com')).toBe('job-2');
        expect(registry.accounts()).toEqual(['me@icloud.com']);
    });

    it('lists every account with a tracked job', () => {
        const registry = new SyncRegistry();
        registry.track('a@icloud.com', 'job-a');
        registry.track('b@icloud.com', 'job-b');
        expect(registry.accounts().sort()).toEqual(['a@icloud.com', 'b@icloud.com']);
    });
});
