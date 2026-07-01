import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Koa from 'koa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeServer } from '../_helpers/server.js';
import { staticSpa } from '../../src/modules/http/static.spa.js';

describe('staticSpa middleware', () => {
    let dir: string;
    let server: Server;
    let base: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'spa-'));
        await mkdir(path.join(dir, 'assets'), { recursive: true });
        await writeFile(path.join(dir, 'index.html'), '<!doctype html><div id=root></div>');
        await writeFile(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');

        const app = new Koa();
        // A downstream marker so we can tell when staticSpa passed through.
        app.use(staticSpa(dir));
        app.use(ctx => {
            ctx.status = 418;
            ctx.body = 'passthrough';
        });
        server = app.listen(0);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await closeServer(server);
        await rm(dir, { recursive: true, force: true });
    });

    it('serves index.html at the root', async () => {
        const res = await fetch(`${base}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toContain('id=root');
    });

    it('serves a hashed asset with an immutable cache header', async () => {
        const res = await fetch(`${base}/assets/app-abc123.js`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/javascript');
        expect(res.headers.get('cache-control')).toContain('immutable');
    });

    it('falls back to index.html for unknown client routes', async () => {
        const res = await fetch(`${base}/photos/deep/link`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('id=root');
    });

    it('passes non-GET requests through to the next middleware', async () => {
        const res = await fetch(`${base}/whatever`, { method: 'POST' });
        expect(res.status).toBe(418);
        expect(await res.text()).toBe('passthrough');
    });

    it('blocks path traversal', async () => {
        const res = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
        expect(res.status).toBe(403);
    });
});
