import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import { Logger } from '@maroonedsoftware/logger';
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
 *
 * A `pool.on('error')` listener is attached because pg's `Pool` emits `error` on
 * behalf of **idle** clients when the backend drops them (e.g. a Postgres/pgbouncer
 * restart sends `terminating connection due to administrator command`). With no
 * listener, pg re-throws that as an `uncaughtException` and the global handler
 * exits the process. The pool discards the dead client and reconnects on the next
 * acquire, so the correct handling is to log and swallow. `logger` is optional so
 * existing callers and tests need not supply one.
 */
export function registerData(registry: InjectKitRegistry, connectionString: string, logger?: Logger): Kysely<DB> {
    const pool = new KyselyPool({ connectionString, types: KyselyPgTypeOverrides, connectionTimeoutMillis: 10_000 });
    pool.on('error', error => logger?.error('postgres pool background error', error));
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: KyselyDefaultPlugins });

    registry.register(KyselyPool).useInstance(pool);
    registry.register(Kysely).useInstance(db);
    return db;
}
