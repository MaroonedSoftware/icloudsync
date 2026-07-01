import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { createRegistry } from 'injectkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeServer } from '../_helpers/server.js';
import { registerBodyParser } from '../../src/modules/http/body.parser.js';
import { createApiApp } from '../../src/modules/http/server.js';
import { SettingsService } from '../../src/modules/settings/settings.service.js';
import { NotificationsService } from '../../src/modules/notifications/index.js';
import type { NotificationSettings, NotificationSettingsPatch } from '../../src/modules/notifications/index.js';
import type { PhotoLayout } from '../../src/modules/icloud/storage/photo.layout.js';

const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} } as Logger;

class FakeSettings {
    layout: PhotoLayout = 'flat';
    cron = '0 */6 * * *';
    notifications: NotificationSettings = { channel: 'none', throttleHours: 24 };
    all = () => Promise.resolve({ photosLayout: this.layout, syncCron: this.cron, notifications: this.notifications });
    setPhotosLayout = (l: PhotoLayout) => {
        this.layout = l;
        return Promise.resolve();
    };
    setSyncCron = (c: string) => {
        this.cron = c;
        return Promise.resolve();
    };
    setNotifications = (patch: NotificationSettingsPatch) => {
        this.notifications = { ...this.notifications, ...patch };
        return Promise.resolve(this.notifications);
    };
}

class FakeNotifications {
    tests = 0;
    failWith?: string;
    sendTest = () => {
        this.tests += 1;
        return this.failWith ? Promise.reject(new Error(this.failWith)) : Promise.resolve();
    };
}

class FakeBroker {
    scheduled: Array<{ name: string; cron: string }> = [];
    send = () => Promise.resolve();
    schedule = (name: string, cron: string) => {
        this.scheduled.push({ name, cron });
        return Promise.resolve();
    };
    unschedule = () => Promise.resolve();
}

describe('icloud settings routes', () => {
    let server: Server;
    let base: string;
    let settings: FakeSettings;
    let broker: FakeBroker;
    let notifications: FakeNotifications;

    beforeEach(() => {
        settings = new FakeSettings();
        broker = new FakeBroker();
        notifications = new FakeNotifications();
        const registry = createRegistry();
        registry.register(Logger).useInstance(silentLogger);
        registerBodyParser(registry);
        registry.register(SettingsService).useInstance(settings as unknown as SettingsService);
        registry.register(JobBroker).useInstance(broker as unknown as JobBroker);
        registry.register(NotificationsService).useInstance(notifications as unknown as NotificationsService);

        server = createApiApp(registry.build()).listen(0);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(() => closeServer(server));

    const patch = (body: unknown) =>
        fetch(`${base}/icloud/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('returns the current settings', async () => {
        const res = await fetch(`${base}/icloud/settings`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ photosLayout: 'flat', syncCron: '0 */6 * * *', notifications: { channel: 'none', throttleHours: 24 } });
    });

    it('updates the photo layout', async () => {
        const res = await patch({ photosLayout: 'album' });
        expect(res.status).toBe(200);
        expect(settings.layout).toBe('album');
        expect((await res.json()).photosLayout).toBe('album');
        expect(broker.scheduled).toHaveLength(0); // layout change doesn't reschedule
    });

    it('updates the schedule and re-arms the cron', async () => {
        const res = await patch({ syncCron: '0 3 * * *' });
        expect(res.status).toBe(200);
        expect(settings.cron).toBe('0 3 * * *');
        expect(broker.scheduled).toEqual([{ name: 'icloud/sync-sweep', cron: '0 3 * * *' }]);
    });

    it('rejects an invalid cron expression with 400', async () => {
        const res = await patch({ syncCron: '0 3 * *' }); // only 4 fields
        expect(res.status).toBe(400);
        expect(settings.cron).toBe('0 */6 * * *');
    });

    it('rejects an empty update with 400', async () => {
        const res = await patch({});
        expect(res.status).toBe(400);
    });

    it('updates the notification config', async () => {
        const res = await patch({ notifications: { channel: 'webhook', webhookUrl: 'https://hook.example/x' } });
        expect(res.status).toBe(200);
        expect(settings.notifications.channel).toBe('webhook');
        expect((await res.json()).notifications.webhookUrl).toBe('https://hook.example/x');
    });

    it('rejects an invalid webhook URL with 400', async () => {
        const res = await patch({ notifications: { channel: 'webhook', webhookUrl: 'not-a-url' } });
        expect(res.status).toBe(400);
    });

    it('sends a test notification', async () => {
        const res = await fetch(`${base}/icloud/notifications/test`, { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ sent: true });
        expect(notifications.tests).toBe(1);
    });

    it('reports a failed test notification as 422 with the error message', async () => {
        notifications.failWith = 'webhook responded 500';
        const res = await fetch(`${base}/icloud/notifications/test`, { method: 'POST' });
        expect(res.status).toBe(422);
        expect((await res.json()).message).toBe('webhook responded 500');
    });
});
