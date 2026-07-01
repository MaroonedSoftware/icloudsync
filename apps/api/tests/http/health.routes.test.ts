import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Kysely } from 'kysely';
import { Logger } from '@maroonedsoftware/logger';
import { createRegistry } from 'injectkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeServer } from '../_helpers/server.js';
import { registerBodyParser } from '../../src/modules/http/body.parser.js';
import { createApiApp } from '../../src/modules/http/server.js';
import type { DB } from '../../src/modules/data/kysely.js';

const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} } as Logger;

/**
 * Minimal Kysely stand-in for the `sql`select 1``.execute(db)` the health probe
 * runs: the raw-builder resolves an executor via `getExecutor()`, then calls
 * `transformQuery` / `compileQuery` / `executeQuery` on it. `answers` toggles
 * whether the query resolves (pool healthy) or rejects (pool down), so the
 * route's ok/degraded branches can be exercised without a real Postgres pool.
 */
function fakeDb(answers: boolean): Kysely<DB> {
    const executor = {
        transformQuery: (node: unknown) => node,
        compileQuery: () => ({ sql: 'select 1', parameters: [], query: {} }),
        executeQuery: () => (answers ? Promise.resolve({ rows: [{ '?column?': 1 }] }) : Promise.reject(new Error('pool exhausted'))),
    };
    return { getExecutor: () => executor } as unknown as Kysely<DB>;
}

function serve(db: Kysely<DB>): Server {
    const registry = createRegistry();
    registry.register(Logger).useInstance(silentLogger);
    registerBodyParser(registry);
    registry.register(Kysely).useInstance(db);
    return createApiApp(registry.build()).listen(0);
}

describe('health routes', () => {
    let server: Server;
    let base: string;

    afterEach(() => closeServer(server));

    const start = (db: Kysely<DB>) => {
        server = serve(db);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };

    it('returns 200 ok when the database answers select 1', async () => {
        start(fakeDb(true));
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('returns 503 degraded when the database query fails', async () => {
        start(fakeDb(false));
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ status: 'degraded' });
    });
});
