import { z } from 'zod';

/** The delivery channels an admin can select; `none` disables notifications. */
export const NOTIFICATION_CHANNELS = ['none', 'webhook', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Zod schema for the persisted notification config. Every field is optional with
 * a default so a partial `PATCH` merges cleanly and an unset config validates to
 * the built-in defaults (channel `none`, 24h throttle). SMTP/webhook details are
 * only meaningful for their channel but are always allowed to be stored, so the
 * admin can fill them in before switching the channel on.
 */
export const notificationSettingsSchema = z.object({
    /** Active delivery channel. `none` means notifications are off. */
    channel: z.enum(NOTIFICATION_CHANNELS).default('none'),
    /** Minimum hours between re-notifications for the same still-broken account. */
    throttleHours: z
        .number()
        .min(0)
        .max(24 * 30)
        .default(24),
    /** Target URL for the `webhook` channel. */
    webhookUrl: z.string().url().optional(),
    /** SMTP settings for the `email` channel; fields mirror `EmailConfig`. */
    email: z
        .object({
            host: z.string().min(1),
            port: z.number().int().min(1).max(65535),
            secure: z.boolean().default(false),
            username: z.string().optional(),
            password: z.string().optional(),
            from: z.string().min(1),
            to: z.string().min(1),
        })
        .optional(),
});

/** The validated notification config, with defaults applied. */
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

/** The config as it arrives in a `PATCH` (all fields optional; merged over the stored value). */
export const notificationSettingsPatchSchema = notificationSettingsSchema.partial();
export type NotificationSettingsPatch = z.infer<typeof notificationSettingsPatchSchema>;

/** The built-in defaults, used when nothing is persisted yet. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = notificationSettingsSchema.parse({});
