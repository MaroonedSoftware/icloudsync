import { describe, expect, it } from 'vitest';
import { destinationNeedsAlbums, filesystemDestination, type Destination } from '../../src/modules/icloud/storage/photo.destination.js';

describe('filesystemDestination', () => {
    it('keeps the caller-supplied layout/naming and turns sidecars on for the immich preset', () => {
        expect(filesystemDestination('immich', { layout: 'album', naming: 'datetime' })).toEqual({
            kind: 'filesystem',
            preset: 'immich',
            layout: 'album',
            naming: 'datetime',
            sidecars: true,
        });
    });

    it('keeps the caller-supplied layout/naming and leaves sidecars off for the browsable preset', () => {
        expect(filesystemDestination('browsable', { layout: 'flat', naming: 'hash' })).toEqual({
            kind: 'filesystem',
            preset: 'browsable',
            layout: 'flat',
            naming: 'hash',
            sidecars: false,
        });
    });
});

describe('destinationNeedsAlbums', () => {
    const fs = (over: Partial<Destination>): Destination => ({
        kind: 'filesystem',
        preset: 'browsable',
        layout: 'flat',
        naming: 'clean',
        sidecars: false,
        ...over,
    });

    it('is true for album layout or sidecars', () => {
        expect(destinationNeedsAlbums(fs({ layout: 'album' }))).toBe(true);
        expect(destinationNeedsAlbums(fs({ sidecars: true }))).toBe(true);
    });

    it('is false for a flat/date archive without sidecars', () => {
        expect(destinationNeedsAlbums(fs({ layout: 'flat' }))).toBe(false);
        expect(destinationNeedsAlbums(fs({ layout: 'date' }))).toBe(false);
    });
});
