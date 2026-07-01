import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPath, databaseUrl, loadAppConfig, webRoot } from '../../src/modules/config/app.config.js';
import { HttpConfig } from '../../src/modules/http/http.config.js';
import { ICloudConfig } from '../../src/modules/icloud/icloud.config.js';

const CONFIG_PATH = fileURLToPath(new URL('../../config/app.yaml', import.meta.url));
const KEYS = [
    'ICLOUD_ACCOUNT_NAME',
    'ICLOUD_SESSION_DIR',
    'ICLOUD_PHOTOS_DIR',
    'ICLOUD_PHOTOS_LAYOUT',
    'ICLOUD_ENCRYPTION_SECRET',
    'ICLOUD_ENCRYPTION_SALT',
    'PORT',
    'DATABASE_URL',
    'SYNC_CRON',
    'WEB_ROOT',
    'APP_CONFIG_PATH',
] as const;

describe('app config pipeline', () => {
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
        for (const k of KEYS) delete process.env[k];
    });
    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('resolves ${env:...} references and validates each section', async () => {
        process.env.ICLOUD_ENCRYPTION_SECRET = 'a-strong-secret-123';
        process.env.ICLOUD_PHOTOS_DIR = '/data/photos';
        process.env.ICLOUD_ENCRYPTION_SALT = 'deadbeef';
        process.env.PORT = '8080';
        process.env.DATABASE_URL = 'postgres://localhost:5432/icloudsync';

        const config = await loadAppConfig(CONFIG_PATH);
        const icloud = ICloudConfig.fromAppConfig(config);

        expect(icloud.photosDir).toBe('/data/photos');
        expect(icloud.encryptionSecret).toBe('a-strong-secret-123');
        expect(icloud.encryptionSalt).toBe('deadbeef');
        expect(HttpConfig.fromAppConfig(config).port).toBe(8080);
        expect(databaseUrl(config)).toBe('postgres://localhost:5432/icloudsync');
    });

    it('applies defaults for unset optional variables', async () => {
        process.env.ICLOUD_ENCRYPTION_SECRET = 'a-strong-secret-123';
        // PORT, ICLOUD_PHOTOS_DIR, ICLOUD_ENCRYPTION_SALT left unset

        const config = await loadAppConfig(CONFIG_PATH);
        const icloud = ICloudConfig.fromAppConfig(config);

        expect(icloud.photosDir).toBe(path.join(homedir(), '.icloudsync', 'photos'));
        expect(icloud.encryptionSalt).toBeUndefined();
        expect(HttpConfig.fromAppConfig(config).port).toBe(3000);
    });

    it('throws when the encryption secret is missing', async () => {
        // ICLOUD_ENCRYPTION_SECRET unset → empty string → fails min(8)
        const config = await loadAppConfig(CONFIG_PATH);
        expect(() => ICloudConfig.fromAppConfig(config)).toThrow();
    });

    it('throws when the database url is missing', async () => {
        const config = await loadAppConfig(CONFIG_PATH);
        expect(() => databaseUrl(config)).toThrow();
    });

    it('resolves the config path from cwd by default and honours APP_CONFIG_PATH', () => {
        expect(configPath({})).toBe(path.resolve(process.cwd(), 'config', 'app.yaml'));
        expect(configPath({ APP_CONFIG_PATH: '/etc/icloudsync/app.yaml' })).toBe('/etc/icloudsync/app.yaml');
    });

    it('returns the web root when set and undefined when unset', async () => {
        const unset = await loadAppConfig(CONFIG_PATH);
        expect(webRoot(unset)).toBeUndefined();

        process.env.WEB_ROOT = '/srv/app/apps/web/dist';
        const set = await loadAppConfig(CONFIG_PATH);
        expect(webRoot(set)).toBe('/srv/app/apps/web/dist');
    });
});
