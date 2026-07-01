import { describe, expect, it } from 'vitest';
import { layoutGroup } from '../../src/modules/icloud/storage/photo.layout.js';

describe('layoutGroup', () => {
    it('flat → no grouping folder', () => {
        expect(layoutGroup('flat', { recordName: 'a', assetDate: Date.UTC(2024, 2, 9) })).toBeUndefined();
    });

    it('date → YYYY/YYYY-MM from the capture date', () => {
        expect(layoutGroup('date', { recordName: 'a', assetDate: Date.UTC(2024, 2, 9) })).toBe('2024/2024-03');
        expect(layoutGroup('date', { recordName: 'a', assetDate: Date.UTC(2009, 11, 31) })).toBe('2009/2009-12');
    });

    it('date → "undated" when the capture date is missing or invalid', () => {
        expect(layoutGroup('date', { recordName: 'a' })).toBe('undated');
        expect(layoutGroup('date', { recordName: 'a', assetDate: Number.NaN })).toBe('undated');
    });

    it('album → the album name from the lookup', () => {
        expect(layoutGroup('album', { recordName: 'a' }, () => 'Vacation 2024')).toBe('Vacation 2024');
    });

    it('album → "Unsorted" when the asset is in no album', () => {
        expect(layoutGroup('album', { recordName: 'a' }, () => undefined)).toBe('Unsorted');
        expect(layoutGroup('album', { recordName: 'a' })).toBe('Unsorted');
    });

    it('album → sanitizes path separators in the album name', () => {
        expect(layoutGroup('album', { recordName: 'a' }, () => 'Trips/2024')).toBe('Trips_2024');
    });
});
