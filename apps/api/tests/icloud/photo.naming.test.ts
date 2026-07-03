import { describe, expect, it } from 'vitest';
import { PHOTO_NAMINGS, namingLeaf, shortHash, withSuffix } from '../../src/modules/icloud/storage/photo.naming.js';

const ASSET_DATE = Date.UTC(2024, 2, 15, 14, 30, 22); // 2024-03-15 14:30:22 UTC

describe('photo naming', () => {
    it('lists exactly the three schemes', () => {
        expect([...PHOTO_NAMINGS]).toEqual(['clean', 'datetime', 'hash']);
    });

    describe('clean', () => {
        it('keeps the original filename as-is', () => {
            expect(namingLeaf('clean', { recordName: 'rec-1', filename: 'IMG_0001.HEIC' })).toBe('IMG_0001.HEIC');
        });

        it('sanitizes separators, NUL, and leading dots', () => {
            expect(namingLeaf('clean', { recordName: 'rec', filename: 'a/b\\c\x00d.jpg' })).toBe('a_b_c_d.jpg');
            expect(namingLeaf('clean', { recordName: 'rec', filename: '...hidden.jpg' })).toBe('hidden.jpg');
        });

        it('falls back to the recordName when the filename is missing or sanitizes away', () => {
            expect(namingLeaf('clean', { recordName: 'rec-1' })).toBe('rec-1');
            expect(namingLeaf('clean', { recordName: 'rec-1', filename: '   ' })).toBe('rec-1');
            expect(namingLeaf('clean', { recordName: 'rec-1', filename: '...' })).toBe('rec-1');
        });
    });

    describe('datetime', () => {
        it('prefixes the capture timestamp (UTC) to the filename', () => {
            expect(namingLeaf('datetime', { recordName: 'rec-1', filename: 'IMG_0001.HEIC', assetDate: ASSET_DATE })).toBe(
                '20240315-143022_IMG_0001.HEIC',
            );
        });

        it('uses `undated` when the capture date is missing or invalid', () => {
            expect(namingLeaf('datetime', { recordName: 'rec-1', filename: 'IMG.HEIC' })).toBe('undated_IMG.HEIC');
            expect(namingLeaf('datetime', { recordName: 'rec-1', filename: 'IMG.HEIC', assetDate: Number.NaN })).toBe('undated_IMG.HEIC');
        });
    });

    describe('hash', () => {
        it('inserts a stable 6-char record hash before the extension', () => {
            const leaf = namingLeaf('hash', { recordName: 'rec-1', filename: 'IMG_0001.HEIC' });
            expect(leaf).toBe(`IMG_0001~${shortHash('rec-1')}.HEIC`);
            expect(leaf).toMatch(/^IMG_0001~[0-9a-f]{6}\.HEIC$/);
        });

        it('is deterministic and distinct per record', () => {
            const a = namingLeaf('hash', { recordName: 'rec-1', filename: 'x.jpg' });
            const b = namingLeaf('hash', { recordName: 'rec-2', filename: 'x.jpg' });
            expect(a).toBe(namingLeaf('hash', { recordName: 'rec-1', filename: 'x.jpg' }));
            expect(a).not.toBe(b);
        });

        it('appends the hash after the recordName stem when there is no extension', () => {
            expect(namingLeaf('hash', { recordName: 'rec-1' })).toBe(`rec-1~${shortHash('rec-1')}`);
        });
    });

    describe('withSuffix', () => {
        it('inserts before the last extension', () => {
            expect(withSuffix('IMG.HEIC', '~ab12cd')).toBe('IMG~ab12cd.HEIC');
            expect(withSuffix('a.b.c.jpg', '~x')).toBe('a.b.c~x.jpg');
        });

        it('appends when there is no extension', () => {
            expect(withSuffix('IMG', '~ab12cd')).toBe('IMG~ab12cd');
        });
    });
});
