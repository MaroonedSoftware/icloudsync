import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Logger } from '@maroonedsoftware/logger';
import { createRegistry } from 'injectkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeServer } from '../_helpers/server.js';
import { registerBodyParser } from '../../src/modules/http/body.parser.js';
import { createApiApp } from '../../src/modules/http/server.js';
import { ICloudService } from '../../src/modules/icloud/icloud.service.js';

const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} } as Logger;

/** With a SPA mounted, API routes must still win and unknown API paths must still 404. */
describe('createApiApp with SPA', () => {
    let dir: string;
    let server: Server;
    let base: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'spa-int-'));
        await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>iCloud Sync</title>');

        const registry = createRegistry();
        registry.register(Logger).useInstance(silentLogger);
        registerBodyParser(registry);
        registry
            .register(ICloudService)
            .useInstance({ accountsStatus: async () => [{ account: 'me@icloud.com', authenticated: true }] } as unknown as ICloudService);

        server = createApiApp(registry.build(), { webRoot: dir }).listen(0);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await closeServer(server);
        await rm(dir, { recursive: true, force: true });
    });

    it('serves the SPA shell at the root', async () => {
        const res = await fetch(`${base}/`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('iCloud Sync');
    });

    it('serves the SPA for unknown client routes', async () => {
        const res = await fetch(`${base}/photos`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
    });

    it('still serves the API JSON, not the SPA', async () => {
        const res = await fetch(`${base}/icloud/accounts`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ accounts: [{ account: 'me@icloud.com', authenticated: true }] });
    });

    it('still 404s an unknown API route instead of returning the SPA', async () => {
        const res = await fetch(`${base}/icloud/bogus`);
        expect(res.status).toBe(404);
    });
});
