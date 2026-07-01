import { homedir } from 'node:os';
import path from 'node:path';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { z } from 'zod';
import type { AppConfigShape } from '../config/app.config.js';

/** Treat an unset value (`''`/`null`/`undefined`) as missing; stringify anything else. */
const emptyToUndefined = (value: unknown): unknown => (value === '' || value == null ? undefined : String(value));

const DEFAULT_PHOTOS_DIR = path.join(homedir(), '.icloudsync', 'photos');

/**
 * Bootstrap/infra configuration for the iCloud module, sourced from the resolved
 * {@link AppConfig} `icloud` section (env). These are deploy-time concerns that
 * must exist before the database is reachable, or are secrets that shouldn't be
 * stored in it: `encryptionSecret` stretches (Argon2id) into the AES-256 key
 * that protects the persisted session at rest. The session itself lives in the
 * database (no session directory needed); only the photo archive uses a
 * directory. User-facing settings (account, photo layout, sync schedule) also
 * live in the database — see {@link SettingsService}.
 */
const schema = z.object({
    /** Directory the backed-up photo files are written to (disk backend). */
    photosDir: z.preprocess(emptyToUndefined, z.string().min(1).default(DEFAULT_PHOTOS_DIR)),
    encryptionSecret: z.preprocess(emptyToUndefined, z.string().min(8)),
    /** Optional hex-encoded Argon2id salt; auto-managed in the database when omitted. */
    encryptionSalt: z.preprocess(emptyToUndefined, z.string().optional()),
});

/** Raw (pre-validation) input accepted by {@link ICloudConfig}; matches the env/`icloud` section shape. */
export type ICloudConfigValues = z.input<typeof schema>;

/**
 * Validated, parsed view of the iCloud module's bootstrap config (see the
 * {@link schema} for what each field means and how defaults/secrets are handled).
 * Construction validates and applies defaults, so an instance is always complete.
 */
export class ICloudConfig {
    readonly photosDir: string;
    readonly encryptionSecret: string;
    readonly encryptionSalt?: string;

    constructor(values: ICloudConfigValues) {
        const parsed = schema.parse(values);
        this.photosDir = parsed.photosDir;
        this.encryptionSecret = parsed.encryptionSecret;
        this.encryptionSalt = parsed.encryptionSalt;
    }

    /** Build from the `icloud` section of a resolved {@link AppConfig}. */
    static fromAppConfig(config: AppConfig<AppConfigShape>): ICloudConfig {
        return new ICloudConfig(config.getObject('icloud') as ICloudConfigValues);
    }
}
