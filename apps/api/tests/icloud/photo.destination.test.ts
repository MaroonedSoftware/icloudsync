import { describe, expect, it } from 'vitest';
import {
    destinationNeedsAlbums,
    destinationSettingSchema,
    filesystemDestination,
    type Destination,
} from '../../src/modules/icloud/storage/photo.destination.js';

describe('filesystemDestination', () => {
    it('immich preset → flat, clean, sidecars on', () => {
        expect(filesystemDestination('immich', { layout: 'date', naming: 'hash' })).toEqual({
            kind: 'filesystem',
            preset: 'immich',
            layout: 'flat',
            naming: 'clean',
            sidecars: true,
        });
    });

    it('browsable preset → date tree, clean names, no sidecars', () => {
        expect(filesystemDestination('browsable', { layout: 'flat', naming: 'hash' })).toEqual({
            kind: 'filesystem',
            preset: 'browsable',
            layout: 'date',
            naming: 'clean',
            sidecars: false,
        });
    });

    it('custom preset → the caller-supplied layout/naming, no sidecars', () => {
        expect(filesystemDestination('custom', { layout: 'album', naming: 'datetime' })).toEqual({
            kind: 'filesystem',
            preset: 'custom',
            layout: 'album',
            naming: 'datetime',
            sidecars: false,
        });
    });
});

describe('destinationNeedsAlbums', () => {
    const fs = (over: Partial<Extract<Destination, { kind: 'filesystem' }>>): Destination => ({
        kind: 'filesystem',
        preset: 'custom',
        layout: 'flat',
        naming: 'clean',
        sidecars: false,
        ...over,
    });

    it('is true for album layout, sidecars, or Immich album recreation', () => {
        expect(destinationNeedsAlbums(fs({ layout: 'album' }))).toBe(true);
        expect(destinationNeedsAlbums(fs({ sidecars: true }))).toBe(true);
        expect(destinationNeedsAlbums({ kind: 'immich', baseUrl: 'https://i', apiKey: 'k', recreateAlbums: true, syncFavorites: false })).toBe(true);
    });

    it('is false for a flat/date archive and for Immich without album recreation', () => {
        expect(destinationNeedsAlbums(fs({ layout: 'flat' }))).toBe(false);
        expect(destinationNeedsAlbums(fs({ layout: 'date' }))).toBe(false);
        expect(destinationNeedsAlbums({ kind: 'immich', baseUrl: 'https://i', apiKey: 'k', recreateAlbums: false, syncFavorites: true })).toBe(false);
    });
});

describe('destinationSettingSchema', () => {
    it('accepts a filesystem preset', () => {
        expect(destinationSettingSchema.parse({ kind: 'filesystem', preset: 'immich' })).toEqual({ kind: 'filesystem', preset: 'immich' });
    });

    it('defaults the Immich reconcile flags when omitted', () => {
        expect(destinationSettingSchema.parse({ kind: 'immich', baseUrl: 'https://immich.test', apiKey: 'k' })).toEqual({
            kind: 'immich',
            baseUrl: 'https://immich.test',
            apiKey: 'k',
            recreateAlbums: true,
            syncFavorites: true,
        });
    });

    it('rejects an Immich destination with a non-URL base or empty key', () => {
        expect(destinationSettingSchema.safeParse({ kind: 'immich', baseUrl: 'not a url', apiKey: 'k' }).success).toBe(false);
        expect(destinationSettingSchema.safeParse({ kind: 'immich', baseUrl: 'https://immich.test', apiKey: '' }).success).toBe(false);
    });

    it('rejects an unknown filesystem preset', () => {
        expect(destinationSettingSchema.safeParse({ kind: 'filesystem', preset: 'nope' }).success).toBe(false);
    });
});
