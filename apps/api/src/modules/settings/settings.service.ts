import { Kysely, sql } from 'kysely';
import { DEFAULT_SYNC_CRON } from '../icloud/sync/sync.defaults.js';
import { PHOTO_LAYOUTS, type PhotoLayout } from '../icloud/storage/photo.layout.js';
import { PHOTO_NAMINGS, type PhotoNaming } from '../icloud/storage/photo.naming.js';
import { destinationSettingSchema, type DestinationSetting } from '../icloud/storage/photo.destination.js';
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
    destination: 'photos_destination',
    syncCron: 'sync_cron',
    notifications: 'notifications',
    /** Runtime throttle state: `{ [account]: lastNotifiedIso }`. Not part of {@link AppSettingsValues}. */
    reauthNotifyState: 'reauth_notify_state',
} as const;

/**
 * Default destination for a fresh install (and the value a pre-destination
 * install resolves to): the filesystem archive in `custom` mode, so whatever
 * `photos_layout` / `photos_naming` were already configured are honored verbatim
 * and nothing about existing backups changes. The UI nudges toward the `immich`
 * preset from here.
 */
export const DEFAULT_DESTINATION: DestinationSetting = { kind: 'filesystem', preset: 'custom' };

/** The user-facing settings, with defaults applied. */
export interface AppSettingsValues {
    /** Where photos are backed up, and how they're organized once there. */
    destination: DestinationSetting;
    /** On-disk photo organization (which folders assets are filed under). Used by the `custom` filesystem preset. */
    photosLayout: PhotoLayout;
    /** How archived photo filenames are composed within their layout folder. Used by the `custom` filesystem preset. */
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
 * the backup destination, photo layout, and sync schedule (all global across
 * accounts) — the set of
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

    /**
     * The backup destination config, with defaults applied. Falls back to
     * {@link DEFAULT_DESTINATION} when unset or when a stored value fails to
     * validate (e.g. a schema change), so the job always has a usable value.
     */
    async destination(): Promise<DestinationSetting> {
        const stored = await this.read<unknown>(KEY.destination);
        if (stored === undefined) return DEFAULT_DESTINATION;
        const parsed = destinationSettingSchema.safeParse(stored);
        return parsed.success ? parsed.data : DEFAULT_DESTINATION;
    }

    /** Validate and persist the backup destination config, returning the stored value. */
    async setDestination(patch: DestinationSetting): Promise<DestinationSetting> {
        const value = destinationSettingSchema.parse(patch);
        await this.write(KEY.destination, value);
        return value;
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
        const [destination, photosLayout, photosNaming, syncCron, notifications] = await Promise.all([
            this.destination(),
            this.photosLayout(),
            this.photosNaming(),
            this.syncCron(),
            this.notifications(),
        ]);
        return { destination, photosLayout, photosNaming, syncCron, notifications };
    }
}
