import { z } from 'zod';
import { LOG_LEVELS } from './rotating.file.logger.js';

/**
 * Zod schema for the persisted, user-editable logging config. Unlike the env
 * {@link LogConfig} (which owns the log *directory* — infra tied to the mounted
 * volume — plus the pre-database boot fallback), these are the runtime knobs the
 * admin turns in the UI: whether the file log is on, its level, and the rotation
 * limits. Every field has a default so a partial `PATCH` merges cleanly and an
 * unset config validates to the built-in defaults.
 */
export const loggingSettingsSchema = z.object({
    /** Whether to write the rotating file log. `false` stops file writes; console output is unaffected. */
    enabled: z.boolean().default(true),
    /** Lowest level to persist. */
    level: z.enum(LOG_LEVELS).default('info'),
    /** Roll the active file over once it passes this many megabytes. */
    maxSizeMb: z.number().positive().max(1024).default(5),
    /** Total files to keep, including the active one. */
    maxFiles: z.number().int().min(1).max(100).default(5),
});

/** The validated logging config, with defaults applied. */
export type LoggingSettings = z.infer<typeof loggingSettingsSchema>;

/** The config as it arrives in a `PATCH` (all fields optional; merged over the stored value). */
export const loggingSettingsPatchSchema = loggingSettingsSchema.partial();
export type LoggingSettingsPatch = z.infer<typeof loggingSettingsPatchSchema>;

/** The built-in defaults, used when nothing is persisted yet. Match the env {@link LogConfig} defaults. */
export const DEFAULT_LOGGING_SETTINGS: LoggingSettings = loggingSettingsSchema.parse({});
