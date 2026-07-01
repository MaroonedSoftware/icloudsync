import type { AppConfig } from '@maroonedsoftware/appconfig';
import { z } from 'zod';
import type { AppConfigShape } from '../config/app.config.js';

/**
 * Configuration for the HTTP server. Sourced from the resolved {@link AppConfig}
 * `http` section by default.
 */
const schema = z.object({
    /** TCP port the API listens on. `0` selects an ephemeral port (used by tests). Defaults to 3000. */
    port: z.preprocess(
        value => (value === '' || value == null ? undefined : value),
        z.coerce.number().int().min(0).max(65535).default(3000),
    ),
});

export type HttpConfigValues = z.input<typeof schema>;

export class HttpConfig {
    readonly port: number;

    constructor(values: HttpConfigValues) {
        this.port = schema.parse(values).port;
    }

    /** Build from the `http` section of a resolved {@link AppConfig}. */
    static fromAppConfig(config: AppConfig<AppConfigShape>): HttpConfig {
        return new HttpConfig(config.getObject('http') as HttpConfigValues);
    }
}
