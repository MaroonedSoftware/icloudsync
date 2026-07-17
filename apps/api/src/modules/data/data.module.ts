import { KyselyDefaultPlugins, KyselyPgTypeOverrides, KyselyPool } from '@maroonedsoftware/kysely';
import { Logger } from '@maroonedsoftware/logger';
import type { InjectKitRegistry } from 'injectkit';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './kysely.js';

/**
 * Every connection this process opens carries an `application_name` so it can be
 * told apart in `pg_stat_activity` (and in a pooler's client list, e.g.
 * pgbouncer's `SHOW CLIENTS`, if one is deployed in front of Postgres) — which is
 * what makes it possible to size the database against what the app actually opens.
 */
export const KYSELY_APPLICATION_NAME = 'icloudsync-kysely';

/**
 * The Kysely pool's server-connection budget, pinned to node-postgres's own
 * default (10) so it is documented rather than implicit. This process opens at
 * most this many **plus** pg-boss's `max` server connections to Postgres; that
 * sum is what Postgres's `max_connections` (or, if a pooler like pgbouncer fronts
 * it, its pool size) must accommodate. See `PGBOSS_POOL_MAX` in the sync module.
 */
export const KYSELY_POOL_MAX = 10;

/**
 * Database connectivity blips surface as background errors on both the Kysely
 * pool and pg-boss: a Postgres (or pooler) restart (`terminating connection due
 * to administrator command`, SQLSTATE `57P01`), the server being unreachable
 * (`ECONNREFUSED`), or a saturated/slow server (`Connection terminated due to
 * connection timeout`, `timeout exceeded when trying to connect`). All are
 * transient and self-healing — the pg pool discards the dead client and
 * reconnects on the next acquire; pg-boss retries on its next interval — so they
 * are not genuine faults to alert on.
 */
export function isTransientConnectionError(error: unknown): boolean {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    // Node syscall codes (server unreachable) + pg SQLSTATEs 57P01 admin_shutdown,
    // 57P03 cannot_connect_now (backend restarting).
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === '57P01' || code === '57P03') return true;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'terminating connection due to administrator command',
        'Connection terminated due to connection timeout',
        'Connection terminated unexpectedly',
        'timeout exceeded when trying to connect',
        'the database system is starting up',
    ].some(pattern => message.includes(pattern));
}

/**
 * Log a background database error at a severity that matches its meaning.
 *
 * A database restart or a few seconds of server saturation can emit dozens of
 * near-identical background errors across the pg pool and pg-boss's several
 * internal timers. Logging each at ERROR with a full stack turns a routine,
 * self-healing blip into a wall of alarming traces (see the connection-error
 * floods this app already rides through). So {@link isTransientConnectionError}
 * cases are logged at WARN as a single line (no stack — the stack is always the
 * same pg-pool frame and carries no signal); anything else stays ERROR with the
 * full error object. `logger` is optional so existing callers/tests need not
 * supply one.
 */
export function logDbBackgroundError(logger: Logger | undefined, source: string, error: unknown): void {
    if (isTransientConnectionError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.warn(`${source}: transient database connectivity error, will retry (${message})`);
        return;
    }
    logger?.error(`${source} background error`, error);
}

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
    const pool = new KyselyPool({
        connectionString,
        types: KyselyPgTypeOverrides,
        connectionTimeoutMillis: 10_000,
        max: KYSELY_POOL_MAX,
        application_name: KYSELY_APPLICATION_NAME,
    });
    pool.on('error', error => logDbBackgroundError(logger, 'postgres pool', error));
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: KyselyDefaultPlugins });

    registry.register(KyselyPool).useInstance(pool);
    registry.register(Kysely).useInstance(db);
    return db;
}
