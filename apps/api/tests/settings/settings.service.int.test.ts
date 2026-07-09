import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SettingsService } from '../../src/modules/settings/settings.service.js';
import type { DB } from '../../src/modules/data/kysely.js';

/**
 * Integration test against the project's local Postgres. Self-skipping when the
 * database is unreachable, so the suite stays green without it.
 */
const CONNECTION = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/icloudsync?sslmode=disable';

let db: Kysely<DB> | undefined;
let settings: SettingsService;
let available = false;

beforeAll(async () => {
    try {
        const pool = new KyselyPool({ connectionString: CONNECTION, types: KyselyPgTypeOverrides });
        db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: KyselyDefaultPlugins });
        await sql`select 1`.execute(db);
        settings = new SettingsService(db);
        available = true;
    } catch {
        available = false;
        if (db) await db.destroy();
        db = undefined;
    }
});

afterAll(async () => {
    if (db) {
        // Scope the wipe to the user-facing settings keys so a concurrent test file's
        // encryption salt (also in app_settings) survives.
        await db.deleteFrom('appSettings').where('key', '!=', 'icloud_encryption_salt').execute();
        await db.destroy();
    }
});

describe('SettingsService (integration)', () => {
    it('returns defaults when unset, then persists and reads back values', async () => {
        if (!available || !db) {
            console.warn('[settings.service.int] skipped — Postgres unreachable');
            return;
        }
        // Scope the wipe to the user-facing settings keys so a concurrent test file's
        // encryption salt (also in app_settings) survives.
        await db.deleteFrom('appSettings').where('key', '!=', 'icloud_encryption_salt').execute();

        // Defaults when empty.
        expect(await settings.syncCron()).toBe('0 */6 * * *');
        expect(await settings.notifications()).toEqual({ channel: 'none', throttleHours: 24 });
        expect(await settings.logging()).toEqual({ enabled: true, level: 'info', maxSizeMb: 5, maxFiles: 5 });

        // Persist.
        await settings.setSyncCron('0 3 * * *');
        await settings.setNotifications({ channel: 'webhook', webhookUrl: 'https://hook.example/x' });
        await settings.setLogging({ enabled: false, level: 'debug', maxSizeMb: 20 });

        // Read back (a fresh instance to prove it's the DB, not memory).
        const fresh = new SettingsService(db);
        expect(await fresh.all()).toEqual({
            syncCron: '0 3 * * *',
            notifications: { channel: 'webhook', throttleHours: 24, webhookUrl: 'https://hook.example/x' },
            // A partial patch merged over the defaults: maxFiles kept its default.
            logging: { enabled: false, level: 'debug', maxSizeMb: 20, maxFiles: 5 },
        });

        // Upsert overwrites.
        await settings.setSyncCron('0 6 * * *');
        expect(await fresh.syncCron()).toBe('0 6 * * *');
    });

    it('persists and clears per-account reauth-notification throttle state', async () => {
        if (!available || !db) {
            console.warn('[settings.service.int] skipped — Postgres unreachable');
            return;
        }
        // Scope the wipe to the user-facing settings keys so a concurrent test file's
        // encryption salt (also in app_settings) survives.
        await db.deleteFrom('appSettings').where('key', '!=', 'icloud_encryption_salt').execute();

        expect(await settings.reauthNotifiedAt('me@icloud.com')).toBeUndefined();
        await settings.setReauthNotifiedAt('me@icloud.com', '2026-07-01T00:00:00.000Z');
        await settings.setReauthNotifiedAt('other@icloud.com', '2026-07-02T00:00:00.000Z');

        const fresh = new SettingsService(db);
        expect(await fresh.reauthNotifiedAt('me@icloud.com')).toBe('2026-07-01T00:00:00.000Z');

        await settings.clearReauthNotified('me@icloud.com');
        expect(await fresh.reauthNotifiedAt('me@icloud.com')).toBeUndefined();
        // Clearing one account leaves the others intact.
        expect(await fresh.reauthNotifiedAt('other@icloud.com')).toBe('2026-07-02T00:00:00.000Z');
    });
});
