import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICloudConfig } from '../../src/modules/icloud/icloud.config.js';

const DEFAULT_PHOTOS_DIR = path.join(homedir(), '.icloudsync', 'photos');

describe('ICloudConfig', () => {
    it('applies the default photos directory when none is provided', () => {
        const config = new ICloudConfig({ encryptionSecret: 'a-strong-secret' });
        expect(config.photosDir).toBe(DEFAULT_PHOTOS_DIR);
    });

    it('keeps an explicit photos directory', () => {
        const config = new ICloudConfig({ encryptionSecret: 'a-strong-secret', photosDir: '/data/photos' });
        expect(config.photosDir).toBe('/data/photos');
    });

    it('treats an empty-string photos directory as unset and falls back to the default', () => {
        const config = new ICloudConfig({ encryptionSecret: 'a-strong-secret', photosDir: '' });
        expect(config.photosDir).toBe(DEFAULT_PHOTOS_DIR);
    });

    it('leaves the encryption salt undefined when omitted (auto-managed later)', () => {
        const config = new ICloudConfig({ encryptionSecret: 'a-strong-secret' });
        expect(config.encryptionSalt).toBeUndefined();
    });

    it('treats an empty-string salt as unset rather than an empty salt', () => {
        const config = new ICloudConfig({ encryptionSecret: 'a-strong-secret', encryptionSalt: '' });
        expect(config.encryptionSalt).toBeUndefined();
    });

    it('preserves an explicit encryption salt', () => {
        const config = new ICloudConfig({ encryptionSecret: 'a-strong-secret', encryptionSalt: 'deadbeef' });
        expect(config.encryptionSalt).toBe('deadbeef');
    });

    it('rejects a missing encryption secret', () => {
        expect(() => new ICloudConfig({} as never)).toThrow();
    });

    it('rejects an encryption secret shorter than 8 characters', () => {
        expect(() => new ICloudConfig({ encryptionSecret: 'short' })).toThrow();
    });

    it('rejects an empty-string encryption secret (treated as missing)', () => {
        expect(() => new ICloudConfig({ encryptionSecret: '' })).toThrow();
    });

    it('defaults the thumbnail-cache budget to 10 MiB when unset', () => {
        const config = new ICloudConfig({ encryptionSecret: 'a-strong-secret' });
        expect(config.thumbnailCacheMaxBytes).toBe(10 * 1024 * 1024);
    });

    it('treats an empty-string thumbnail-cache size as unset and applies the default', () => {
        const config = new ICloudConfig({ encryptionSecret: 'a-strong-secret', thumbnailCacheMaxMb: '' });
        expect(config.thumbnailCacheMaxBytes).toBe(10 * 1024 * 1024);
    });

    it('converts an explicit thumbnail-cache size (MiB) to bytes', () => {
        const config = new ICloudConfig({ encryptionSecret: 'a-strong-secret', thumbnailCacheMaxMb: '25' });
        expect(config.thumbnailCacheMaxBytes).toBe(25 * 1024 * 1024);
    });

    it('allows 0 to disable thumbnails (zero-byte budget)', () => {
        const config = new ICloudConfig({ encryptionSecret: 'a-strong-secret', thumbnailCacheMaxMb: 0 });
        expect(config.thumbnailCacheMaxBytes).toBe(0);
    });

    it('rejects a negative thumbnail-cache size', () => {
        expect(() => new ICloudConfig({ encryptionSecret: 'a-strong-secret', thumbnailCacheMaxMb: -1 })).toThrow();
    });
});
