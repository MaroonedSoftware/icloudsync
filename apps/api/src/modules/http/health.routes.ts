import { ServerKitRouter } from '@maroonedsoftware/koa';
import { Kysely, sql } from 'kysely';
import type { DB } from '../data/kysely.js';

/**
 * Liveness/readiness probe for container orchestrators (the image's Docker
 * `HEALTHCHECK`, Unraid's health dot, k8s). `GET /health` runs a trivial
 * `select 1` against Postgres: `200 { status: 'ok' }` when the pool answers,
 * `503 { status: 'degraded' }` when it does not — so an app that has lost its
 * database reads as unhealthy rather than falsely up.
 *
 * Deliberately outside the `/icloud` surface and unauthenticated: a probe must
 * never need a session, and it is mounted before the static SPA so the path
 * resolves to JSON rather than the history-API fallback.
 */
export function healthRouter() {
    const router = ServerKitRouter();

    router.get('/health', async ctx => {
        try {
            const db = ctx.container.get(Kysely) as Kysely<DB>;
            await sql`select 1`.execute(db);
            ctx.body = { status: 'ok' };
        } catch {
            ctx.status = 503;
            ctx.body = { status: 'degraded' };
        }
    });

    return router;
}
