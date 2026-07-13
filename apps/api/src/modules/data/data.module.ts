import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import type { InjectKitRegistry } from 'injectkit';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './kysely.js';

/**
 * Register the Postgres data layer: a {@link KyselyPool} (with the ServerKit pg
 * type overrides — Luxon dates, BigInt int8) and a `Kysely<DB>` instance wired
 * with {@link KyselyDefaultPlugins} (snake_case ⇄ camelCase + null→undefined).
 *
 * Returns the `Kysely<DB>` for callers that want it directly (tests, bootstrap).
 * `connectionString` is supplied by the caller (from the resolved app config).
 *
 * `connectionTimeoutMillis` is set so a request-path query fails fast (with a
 * clean error) when Postgres is briefly unavailable, rather than hanging on the
 * pg default of `0` (wait forever) and letting stalled requests pile up during a
 * DB blip. pg-boss already bounds its own pool at the same 10s.
 */
export function registerData(registry: InjectKitRegistry, connectionString: string): Kysely<DB> {
    const pool = new KyselyPool({ connectionString, types: KyselyPgTypeOverrides, connectionTimeoutMillis: 10_000 });
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: KyselyDefaultPlugins });

    registry.register(KyselyPool).useInstance(pool);
    registry.register(Kysely).useInstance(db);
    return db;
}
