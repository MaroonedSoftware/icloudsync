import path from 'node:path';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { z } from 'zod';
import type { AppConfigShape } from '../config/app.config.js';
import { LOG_LEVELS } from './rotating.file.logger.js';

/** Treat an unset value (`''`/`null`/`undefined`) as missing so the schema default applies. */
const emptyToUndefined = (value: unknown): unknown => (value === '' || value == null ? undefined : value);

const DEFAULT_DIR = path.resolve(process.cwd(), 'logs');

/**
 * Bootstrap configuration for the rotating file logger, sourced from the resolved
 * {@link AppConfig} `logging` section (env). Logging must be usable before the
 * database is reachable — it is how a boot-time failure gets recorded — so, like
 * {@link ICloudConfig}, these are env-only concerns. See {@link RotatingFileLogger}
 * for what each field controls.
 */
const schema = z.object({
    /** Directory the rotating log files are written to. Defaults to `./logs` under the process cwd. */
    dir: z.preprocess(value => (value === '' || value == null ? undefined : String(value)), z.string().min(1).default(DEFAULT_DIR)),
    /** Lowest level to persist. Defaults to `info`. */
    level: z.preprocess(emptyToUndefined, z.enum(LOG_LEVELS).default('info')),
    /** Rotate once the active file passes this many megabytes. Defaults to 5. */
    maxSizeMb: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(5)),
    /** Total files to keep, including the active one. Defaults to 5. */
    maxFiles: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(5)),
});

/** Raw (pre-validation) input accepted by {@link LogConfig}; matches the env/`logging` section shape. */
export type LogConfigValues = z.input<typeof schema>;

/**
 * Validated, parsed view of the logging module's bootstrap config. Construction
 * validates and applies defaults, so an instance is always complete.
 */
export class LogConfig {
    readonly dir: string;
    readonly level: (typeof LOG_LEVELS)[number];
    /** Rotation threshold in bytes (derived from the `maxSizeMb` setting). */
    readonly maxSizeBytes: number;
    readonly maxFiles: number;

    constructor(values: LogConfigValues) {
        const parsed = schema.parse(values);
        this.dir = parsed.dir;
        this.level = parsed.level;
        this.maxSizeBytes = Math.round(parsed.maxSizeMb * 1_000_000);
        this.maxFiles = parsed.maxFiles;
    }

    /** Build from the `logging` section of a resolved {@link AppConfig}. */
    static fromAppConfig(config: AppConfig<AppConfigShape>): LogConfig {
        return new LogConfig((config.getObject('logging') as LogConfigValues | undefined) ?? {});
    }
}
