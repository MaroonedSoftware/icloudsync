import path from 'node:path';
import { AppConfig, AppConfigBuilder, AppConfigResolverEnv } from '@maroonedsoftware/appconfig';
import { AppConfigSourceYaml } from '@maroonedsoftware/appconfig/yaml';
import { z } from 'zod';

/**
 * The raw, resolved config tree produced by {@link loadAppConfig}, before any
 * per-section validation. Values are whatever the env resolver substituted into
 * `config/app.yaml`: a string for a set variable, `''` for an unset one, or a
 * coerced primitive (e.g. `PORT` becomes a number) where the value parses as
 * JSON. Section consumers ({@link ICloudConfig}, {@link HttpConfig},
 * {@link databaseUrl}) normalise and validate these.
 */
export interface AppConfigShape {
    icloud: { photosDir?: string; encryptionSecret?: string; encryptionSalt?: string };
    http: { port?: number | string };
    database: { url?: string };
    web: { root?: string };
    logging: { dir?: string; level?: string; maxSizeMb?: number | string; maxFiles?: number | string };
}

/**
 * Absolute path to the layered config file. Defaults to `config/app.yaml`
 * relative to the process working directory; override with `APP_CONFIG_PATH`
 * (e.g. for a production deployment that ships the file elsewhere).
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
    return env.APP_CONFIG_PATH ?? path.resolve(process.cwd(), 'config', 'app.yaml');
}

/**
 * Load and resolve the application configuration: read `config/app.yaml`, then
 * substitute every `${env:VAR}` reference from `process.env`. This is the single
 * place that reads the environment — modules receive a typed {@link AppConfig}
 * (or a validated section of it) rather than touching `process.env` directly.
 *
 * A snapshot (not a hot-reloading store) is built; the app reads config once at
 * boot. Swap in `buildStore()` later if live reload is wanted.
 */
export function loadAppConfig(filePath: string = configPath()): Promise<AppConfig<AppConfigShape>> {
    return new AppConfigBuilder()
        .addSource(new AppConfigSourceYaml(filePath))
        .addResolver(new AppConfigResolverEnv())
        .buildSnapshot<AppConfigShape>();
}

const databaseSchema = z.object({
    url: z.preprocess(value => (value === '' || value == null ? undefined : String(value)), z.string().min(1)),
});

/** Read and validate the Postgres connection string from the `database` section. */
export function databaseUrl(config: AppConfig<AppConfigShape>): string {
    return databaseSchema.parse(config.getObject('database')).url;
}

/**
 * Directory of the built web SPA to serve, or `undefined` to disable static
 * serving (API-only). Sourced from the `web` section (`WEB_ROOT`); an unset
 * value means no UI is mounted, which is what the route unit tests rely on.
 */
export function webRoot(config: AppConfig<AppConfigShape>): string | undefined {
    const raw = (config.getObject('web') as AppConfigShape['web']).root;
    return raw === '' || raw == null ? undefined : String(raw);
}
