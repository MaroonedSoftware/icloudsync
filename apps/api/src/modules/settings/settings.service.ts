import { Kysely, sql } from 'kysely';
import { DEFAULT_SYNC_CRON } from '../icloud/sync/sync.defaults.js';
import { PHOTO_LAYOUTS, type PhotoLayout } from '../icloud/storage/photo.layout.js';
import { PHOTO_NAMINGS, type PhotoNaming } from '../icloud/storage/photo.naming.js';
import {
    DEFAULT_NOTIFICATION_SETTINGS,
    notificationSettingsSchema,
    type NotificationSettings,
    type NotificationSettingsPatch,
} from '../notifications/notification.settings.js';
import type { DB, Json } from '../data/kysely.js';

/** Setting keys persisted in `app_settings`. */
const KEY = {
    photosLayout: 'photos_layout',
    photosNaming: 'photos_naming',
    syncCron: 'sync_cron',
    notifications: 'notifications',
    /** Runtime throttle state: `{ [account]: lastNotifiedIso }`. Not part of {@link AppSettingsValues}. */
    reauthNotifyState: 'reauth_notify_state',
} as const;

/** The user-facing settings, with defaults applied. */
export interface AppSettingsValues {
    /** On-disk photo organization (which folders assets are filed under). */
    photosLayout: PhotoLayout;
    /** How archived photo filenames are composed within their layout folder. */
    photosNaming: PhotoNaming;
    /** Sync schedule (cron). */
    syncCron: string;
    /** Admin notification config (channel, throttle, webhook/SMTP details). */
    notifications: NotificationSettings;
}

/**
 * Runtime, user-editable configuration, persisted in Postgres (`app_settings`)
 * rather than the environment. Each setting is a `(key, jsonb value)` row;
 * unset keys fall back to a built-in default. This is the source of truth for
 * the photo layout and sync schedule (both global across accounts) — the set of
 * accounts lives in `icloud_accounts` (see `AccountsService`), and secrets and
 * infra (DB URL, encryption secret, ports, storage paths) stay in env.
 */
export class SettingsService {
    constructor(private readonly db: Kysely<DB>) {}

    private async read<T>(key: string): Promise<T | undefined> {
        const row = await this.db.selectFrom('appSettings').select('value').where('key', '=', key).executeTakeFirst();
        return row ? (row.value as T) : undefined;
    }

    private async write(key: string, value: unknown): Promise<void> {
        const json = sql<Json>`${JSON.stringify(value)}::jsonb`;
        await this.db
            .insertInto('appSettings')
            .values({ key, value: json })
            .onConflict(oc => oc.column('key').doUpdateSet({ value: json, updatedAt: sql`now()` }))
            .execute();
    }

    /** The on-disk photo layout (default `flat`). */
    async photosLayout(): Promise<PhotoLayout> {
        const value = await this.read<string>(KEY.photosLayout);
        return value && (PHOTO_LAYOUTS as readonly string[]).includes(value) ? (value as PhotoLayout) : 'flat';
    }
    setPhotosLayout(layout: PhotoLayout): Promise<void> {
        return this.write(KEY.photosLayout, layout);
    }

    /** The archived-filename scheme (default `clean`). */
    async photosNaming(): Promise<PhotoNaming> {
        const value = await this.read<string>(KEY.photosNaming);
        return value && (PHOTO_NAMINGS as readonly string[]).includes(value) ? (value as PhotoNaming) : 'clean';
    }
    setPhotosNaming(naming: PhotoNaming): Promise<void> {
        return this.write(KEY.photosNaming, naming);
    }

    /** The sync schedule cron (default every 6 hours). */
    async syncCron(): Promise<string> {
        return (await this.read<string>(KEY.syncCron)) ?? DEFAULT_SYNC_CRON;
    }
    setSyncCron(cron: string): Promise<void> {
        return this.write(KEY.syncCron, cron);
    }

    /** The admin notification config, with defaults applied (channel `none`, 24h throttle). */
    async notifications(): Promise<NotificationSettings> {
        const stored = await this.read<unknown>(KEY.notifications);
        if (stored === undefined) return DEFAULT_NOTIFICATION_SETTINGS;
        const parsed = notificationSettingsSchema.safeParse(stored);
        return parsed.success ? parsed.data : DEFAULT_NOTIFICATION_SETTINGS;
    }

    /**
     * Merge a partial notification config over the current one, validate the
     * result, persist it, and return the stored value. `email` is replaced
     * wholesale when present (it validates as a complete object), so callers pass
     * the full SMTP block when changing any of it.
     */
    async setNotifications(patch: NotificationSettingsPatch): Promise<NotificationSettings> {
        const current = await this.notifications();
        const merged = notificationSettingsSchema.parse({ ...current, ...patch });
        await this.write(KEY.notifications, merged);
        return merged;
    }

    /** When `account` was last sent a reauth alert (ISO string), or undefined if never. */
    async reauthNotifiedAt(account: string): Promise<string | undefined> {
        const state = (await this.read<Record<string, string>>(KEY.reauthNotifyState)) ?? {};
        return state[account];
    }

    /** Record that `account` was just sent a reauth alert at `iso`. */
    async setReauthNotifiedAt(account: string, iso: string): Promise<void> {
        const state = (await this.read<Record<string, string>>(KEY.reauthNotifyState)) ?? {};
        state[account] = iso;
        await this.write(KEY.reauthNotifyState, state);
    }

    /** Forget an account's reauth-alert timestamp (call once it is authenticated again). */
    async clearReauthNotified(account: string): Promise<void> {
        const state = (await this.read<Record<string, string>>(KEY.reauthNotifyState)) ?? {};
        if (!(account in state)) return;
        delete state[account];
        await this.write(KEY.reauthNotifyState, state);
    }

    /** All user-facing settings at once, with defaults applied. */
    async all(): Promise<AppSettingsValues> {
        const [photosLayout, photosNaming, syncCron, notifications] = await Promise.all([
            this.photosLayout(),
            this.photosNaming(),
            this.syncCron(),
            this.notifications(),
        ]);
        return { photosLayout, photosNaming, syncCron, notifications };
    }
}
