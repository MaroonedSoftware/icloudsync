import type { Logger } from '@maroonedsoftware/logger';
import type { SettingsService } from '../settings/settings.service.js';
import { EmailNotifier } from './email.notifier.js';
import type { Notification, Notifier } from './notification.js';
import type { NotificationSettings } from './notification.settings.js';
import { WebhookNotifier } from './webhook.notifier.js';

/** Builds the active {@link Notifier} for a config, or `undefined` if none is usable. */
export type NotifierFactory = (config: NotificationSettings) => Notifier | undefined;

/** Default factory: maps the configured channel to its notifier implementation. */
export function defaultNotifierFactory(config: NotificationSettings): Notifier | undefined {
    if (config.channel === 'webhook') return config.webhookUrl ? new WebhookNotifier(config.webhookUrl) : undefined;
    if (config.channel === 'email') return config.email ? new EmailNotifier(config.email) : undefined;
    return undefined;
}

/**
 * Sends admin notifications over the configured channel and owns the
 * re-notification throttle. The main event is {@link notifyReauthRequired}: the
 * sync job calls it whenever a registered account can't be restored (its trust
 * token/session expired), and this service delivers at most one alert per
 * account per configured interval so a broken account doesn't alert on every
 * sync run. When an account authenticates again the job calls {@link clearReauth}
 * so the next failure notifies promptly rather than being suppressed by a stale
 * timestamp still inside the throttle window.
 *
 * Config (channel, throttle, webhook/SMTP details) lives in the database via
 * {@link SettingsService}; this service reads it fresh on each call, so changes
 * take effect without a restart.
 */
export class NotificationsService {
    constructor(
        private readonly settings: SettingsService,
        private readonly logger: Logger,
        private readonly now: () => Date = () => new Date(),
        private readonly notifierFactory: NotifierFactory = defaultNotifierFactory,
    ) {}

    /** Deliver a notification over the configured channel. Returns whether it was sent. */
    async notify(notification: Notification): Promise<boolean> {
        const config = await this.settings.notifications();
        if (config.channel === 'none') return false;

        const notifier = this.notifierFactory(config);
        if (!notifier) {
            this.logger.warn(`[notifications] channel '${config.channel}' selected but not fully configured; skipping`);
            return false;
        }

        await notifier.send(notification);
        this.logger.info(`[notifications] sent '${notification.kind}' via ${notifier.channel}`);
        return true;
    }

    /**
     * Notify the admin that `account` needs to re-authenticate, unless an alert
     * was already sent within the configured throttle window. A delivery failure
     * is logged and leaves the throttle timestamp untouched, so the next sync run
     * retries.
     */
    async notifyReauthRequired(account: string): Promise<void> {
        const config = await this.settings.notifications();
        if (config.channel === 'none') return;

        const lastIso = await this.settings.reauthNotifiedAt(account);
        if (lastIso && this.withinThrottle(lastIso, config.throttleHours)) {
            this.logger.debug(`[notifications] reauth alert for ${account} throttled (last sent ${lastIso})`);
            return;
        }

        try {
            const sent = await this.notify({
                kind: 'reauth_required',
                title: `iCloud account needs re-authentication`,
                message: `The account ${account} could not be restored for backup — its session or trust token has expired. Sign in again to resume syncing.`,
                account,
            });
            if (sent) await this.settings.setReauthNotifiedAt(account, this.now().toISOString());
        } catch (error) {
            this.logger.error(`[notifications] failed to send reauth alert for ${account}`, error);
        }
    }

    /** Forget an account's throttle timestamp (call once it is authenticated again). */
    async clearReauth(account: string): Promise<void> {
        await this.settings.clearReauthNotified(account);
    }

    /**
     * Send a test notification over the configured channel, ignoring the
     * throttle. Throws if notifications are off, misconfigured, or delivery
     * fails, so a UI "Send test" action surfaces the real error.
     */
    async sendTest(): Promise<void> {
        const config = await this.settings.notifications();
        if (config.channel === 'none') throw new Error('notifications are disabled (channel is "none")');

        const notifier = this.notifierFactory(config);
        if (!notifier) throw new Error(`channel '${config.channel}' is selected but not fully configured`);

        await notifier.send({
            kind: 'test',
            title: 'iCloudSync test notification',
            message: 'This is a test notification from iCloudSync. If you received it, your notification settings are working.',
        });
    }

    private withinThrottle(lastIso: string, throttleHours: number): boolean {
        const last = Date.parse(lastIso);
        if (Number.isNaN(last)) return false; // unparseable timestamp -> treat as never notified
        return this.now().getTime() - last < throttleHours * 60 * 60 * 1000;
    }
}
