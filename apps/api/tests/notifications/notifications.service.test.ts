import type { Logger } from '@maroonedsoftware/logger';
import { describe, expect, it } from 'vitest';
import type { Notification, Notifier } from '../../src/modules/notifications/notification.js';
import type { NotificationSettings } from '../../src/modules/notifications/notification.settings.js';
import { NotificationsService } from '../../src/modules/notifications/notifications.service.js';
import type { SettingsService } from '../../src/modules/settings/settings.service.js';

const silentLogger: Logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

/** A SettingsService stand-in holding the notification config + throttle map in memory. */
class FakeSettings {
    state = new Map<string, string>();
    constructor(private readonly config: NotificationSettings) {}
    notifications = async () => this.config;
    reauthNotifiedAt = async (account: string) => this.state.get(account);
    setReauthNotifiedAt = async (account: string, iso: string) => {
        this.state.set(account, iso);
    };
    clearReauthNotified = async (account: string) => {
        this.state.delete(account);
    };
}

/** A notifier that records every notification it is asked to send. */
class SpyNotifier implements Notifier {
    readonly channel = 'spy';
    readonly sent: Notification[] = [];
    failWith?: Error;
    async send(notification: Notification): Promise<void> {
        if (this.failWith) throw this.failWith;
        this.sent.push(notification);
    }
}

function make(config: Partial<NotificationSettings> = {}, now: Date = new Date('2026-07-01T00:00:00Z')) {
    const settings = new FakeSettings({ channel: 'webhook', throttleHours: 24, webhookUrl: 'https://x', ...config });
    const notifier = new SpyNotifier();
    const service = new NotificationsService(
        settings as unknown as SettingsService,
        silentLogger,
        () => now,
        () => notifier,
    );
    return { settings, notifier, service };
}

describe('NotificationsService', () => {
    it('does not notify when the channel is off', async () => {
        const { notifier, service } = make({ channel: 'none' });
        await service.notifyReauthRequired('me@icloud.com');
        expect(notifier.sent).toHaveLength(0);
    });

    it('sends a reauth alert and records the throttle timestamp', async () => {
        const now = new Date('2026-07-01T12:00:00Z');
        const { settings, notifier, service } = make({}, now);

        await service.notifyReauthRequired('me@icloud.com');

        expect(notifier.sent).toHaveLength(1);
        expect(notifier.sent[0]).toMatchObject({ kind: 'reauth_required', account: 'me@icloud.com' });
        expect(settings.state.get('me@icloud.com')).toBe(now.toISOString());
    });

    it('suppresses a repeat alert within the throttle window', async () => {
        const { settings, notifier, service } = make({ throttleHours: 24 }, new Date('2026-07-02T00:00:00Z'));
        settings.state.set('me@icloud.com', '2026-07-01T06:00:00Z'); // 18h ago < 24h window

        await service.notifyReauthRequired('me@icloud.com');

        expect(notifier.sent).toHaveLength(0);
        expect(settings.state.get('me@icloud.com')).toBe('2026-07-01T06:00:00Z'); // unchanged
    });

    it('re-alerts once the throttle window has elapsed', async () => {
        const now = new Date('2026-07-03T00:00:00Z');
        const { settings, notifier, service } = make({ throttleHours: 24 }, now);
        settings.state.set('me@icloud.com', '2026-07-01T00:00:00Z'); // 48h ago > 24h window

        await service.notifyReauthRequired('me@icloud.com');

        expect(notifier.sent).toHaveLength(1);
        expect(settings.state.get('me@icloud.com')).toBe(now.toISOString());
    });

    it('does not record a timestamp when delivery fails, so the next run retries', async () => {
        const { settings, notifier, service } = make();
        notifier.failWith = new Error('boom');

        await service.notifyReauthRequired('me@icloud.com'); // swallowed + logged

        expect(settings.state.has('me@icloud.com')).toBe(false);
    });

    it('clears the throttle state when an account authenticates again', async () => {
        const { settings, service } = make();
        settings.state.set('me@icloud.com', '2026-07-01T00:00:00Z');

        await service.clearReauth('me@icloud.com');

        expect(settings.state.has('me@icloud.com')).toBe(false);
    });

    it('sendTest ignores the throttle and throws when the channel is off', async () => {
        const off = make({ channel: 'none' });
        await expect(off.service.sendTest()).rejects.toThrow(/disabled/);

        const on = make();
        on.settings.state.set('me@icloud.com', new Date().toISOString());
        await on.service.sendTest();
        expect(on.notifier.sent).toHaveLength(1);
        expect(on.notifier.sent[0]!.kind).toBe('test');
    });

    it('warns and skips when the selected channel is not fully configured', async () => {
        const settings = new FakeSettings({ channel: 'webhook', throttleHours: 24 }); // no webhookUrl
        const service = new NotificationsService(settings as unknown as SettingsService, silentLogger, () => new Date());
        const sent = await service.notify({ kind: 'test', title: 't', message: 'm' });
        expect(sent).toBe(false);
    });
});
