import { describe, expect, it } from 'vitest';
import { defaultArchivePrefix } from '../../src/modules/icloud/storage/photo.prefix.js';

describe('defaultArchivePrefix', () => {
    it('drops the domain from the Apple ID email', () => {
        expect(defaultArchivePrefix({ id: 'uuid-1', accountName: 'rdean79@yahoo.com' })).toBe('rdean79');
        expect(defaultArchivePrefix({ id: 'uuid-2', accountName: 'a.b+tag@icloud.com' })).toBe('a.b+tag');
    });

    it('keeps the whole value when there is no domain', () => {
        expect(defaultArchivePrefix({ id: 'uuid-3', accountName: 'plainname' })).toBe('plainname');
    });

    it('sanitizes path-unsafe characters in the local part', () => {
        expect(defaultArchivePrefix({ id: 'uuid-4', accountName: 'a/b\\c@icloud.com' })).toBe('a_b_c');
        expect(defaultArchivePrefix({ id: 'uuid-5', accountName: '.hidden@icloud.com' })).toBe('hidden');
    });

    it('falls back to the account id when the local part sanitizes away', () => {
        expect(defaultArchivePrefix({ id: 'uuid-6', accountName: '@icloud.com' })).toBe('uuid-6');
        expect(defaultArchivePrefix({ id: 'uuid-7', accountName: '   @icloud.com' })).toBe('uuid-7');
    });
});
