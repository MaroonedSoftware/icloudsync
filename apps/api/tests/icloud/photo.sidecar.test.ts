import { describe, expect, it } from 'vitest';
import { buildSidecar, sidecarKey } from '../../src/modules/icloud/storage/photo.sidecar.js';

const CAPTURE = Date.UTC(2024, 2, 9, 14, 30, 22); // 2024-03-09T14:30:22Z

describe('buildSidecar', () => {
    it('returns undefined when there is nothing worth recording', () => {
        expect(buildSidecar({ isFavorite: false, albums: [] })).toBeUndefined();
    });

    it('emits a 5-star rating for a favorite', () => {
        const xmp = buildSidecar({ isFavorite: true, albums: [] })!;
        expect(xmp).toContain('<xmp:Rating>5</xmp:Rating>');
    });

    it('emits album names as de-duplicated keyword tags', () => {
        const xmp = buildSidecar({ isFavorite: false, albums: ['Vacation', 'Vacation', ' ', 'Trips 2024'] })!;
        expect(xmp).toContain('<rdf:li>Vacation</rdf:li>');
        expect(xmp).toContain('<rdf:li>Trips 2024</rdf:li>');
        // "Vacation" appears once per keyword list (dc:subject + hierarchicalSubject) → twice total, not thrice.
        expect(xmp.match(/<rdf:li>Vacation<\/rdf:li>/g)).toHaveLength(2);
    });

    it('emits the capture date as an ISO-8601 timestamp', () => {
        const xmp = buildSidecar({ isFavorite: true, albums: [], assetDate: CAPTURE })!;
        expect(xmp).toContain('<exif:DateTimeOriginal>2024-03-09T14:30:22Z</exif:DateTimeOriginal>');
        expect(xmp).toContain('<photoshop:DateCreated>2024-03-09T14:30:22Z</photoshop:DateCreated>');
    });

    it('omits the date when it is missing or invalid', () => {
        expect(buildSidecar({ isFavorite: true, albums: [], assetDate: Number.NaN })).not.toContain('DateTimeOriginal');
    });

    it('XML-escapes album names', () => {
        const xmp = buildSidecar({ isFavorite: false, albums: ['Me & You <2024>'] })!;
        expect(xmp).toContain('<rdf:li>Me &amp; You &lt;2024&gt;</rdf:li>');
        expect(xmp).not.toContain('Me & You <2024>');
    });
});

describe('sidecarKey', () => {
    it('appends .xmp to the asset key', () => {
        expect(sidecarKey('acct/2024/photo-0.HEIC')).toBe('acct/2024/photo-0.HEIC.xmp');
    });
});
