import { describe, expect, it } from 'vitest';
import {
    destinationNeedsAlbums,
    filesystemDestination,
    immichDestination,
    immichSettingsSchema,
    type Destination,
} from '../../src/modules/icloud/storage/photo.destination.js';

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
    const fs = (over: Partial<Extract<Destination, { kind: 'filesystem' }>>): Destination => ({
        kind: 'filesystem',
        preset: 'browsable',
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

describe('immichSettingsSchema', () => {
    it('defaults the reconcile flags when omitted', () => {
        expect(immichSettingsSchema.parse({ baseUrl: 'https://immich.test', apiKey: 'k' })).toEqual({
            baseUrl: 'https://immich.test',
            apiKey: 'k',
            recreateAlbums: true,
            syncFavorites: true,
        });
    });

    it('rejects a non-URL base or an empty key', () => {
        expect(immichSettingsSchema.safeParse({ baseUrl: 'not a url', apiKey: 'k' }).success).toBe(false);
        expect(immichSettingsSchema.safeParse({ baseUrl: 'https://immich.test', apiKey: '' }).success).toBe(false);
    });
});

describe('immichDestination', () => {
    it('lifts a stored connection into a resolved Immich destination', () => {
        expect(immichDestination({ baseUrl: 'https://immich.test', apiKey: 'k', recreateAlbums: false, syncFavorites: true })).toEqual({
            kind: 'immich',
            baseUrl: 'https://immich.test',
            apiKey: 'k',
            recreateAlbums: false,
            syncFavorites: true,
        });
    });
});
