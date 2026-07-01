import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@maroonedsoftware/logger';
import { createRegistry } from 'injectkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeServer } from '../_helpers/server.js';
import { registerBodyParser } from '../../src/modules/http/body.parser.js';
import { createApiApp } from '../../src/modules/http/server.js';
import { ICloudService, type AccountStatus } from '../../src/modules/icloud/icloud.service.js';
import { PhotosRepository, type PhotoStats } from '../../src/modules/icloud/sync/photos.repository.js';
import { SettingsService } from '../../src/modules/settings/settings.service.js';

const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} } as Logger;

const statsFor = (total: number): PhotoStats => ({
    total,
    favorites: 1,
    backedUp: total,
    backedUpBytes: total * 1000,
    newestAssetDate: 1_700_000_000_000,
    oldestAssetDate: 1_500_000_000_000,
    lastSyncedAt: '2026-06-29T00:00:00.000Z',
});

describe('icloud admin routes', () => {
    let server: Server;
    let base: string;

    beforeEach(() => {
        const statuses: AccountStatus[] = [
            { account: 'a@icloud.com', authenticated: true },
            { account: 'b@icloud.com', authenticated: false },
        ];
        const icloud = { accountsStatus: async () => statuses };
        const repo = { stats: async (account: string) => statsFor(account === 'a@icloud.com' ? 10 : 0) };
        const settings = { syncCron: async () => '0 */6 * * *' };

        const registry = createRegistry();
        registry.register(Logger).useInstance(silentLogger);
        registerBodyParser(registry);
        registry.register(ICloudService).useInstance(icloud as unknown as ICloudService);
        registry.register(PhotosRepository).useInstance(repo as unknown as PhotosRepository);
        registry.register(SettingsService).useInstance(settings as unknown as SettingsService);

        server = createApiApp(registry.build()).listen(0);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(() => closeServer(server));

    it('returns the schedule and per-account status + stats', async () => {
        const res = await fetch(`${base}/icloud/overview`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.schedule).toBe('0 */6 * * *');
        expect(body.accounts).toEqual([
            { account: 'a@icloud.com', authenticated: true, ...statsFor(10) },
            { account: 'b@icloud.com', authenticated: false, ...statsFor(0) },
        ]);
    });
});
