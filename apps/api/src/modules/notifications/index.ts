import { Logger } from '@maroonedsoftware/logger';
import type { InjectKitRegistry } from 'injectkit';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationsService } from './notifications.service.js';

export type { Notification, Notifier } from './notification.js';
export { WebhookNotifier } from './webhook.notifier.js';
export { EmailNotifier } from './email.notifier.js';
export type { EmailConfig, MailTransport } from './email.notifier.js';
export { NotificationsService, defaultNotifierFactory } from './notifications.service.js';
export type { NotifierFactory } from './notifications.service.js';
export {
    NOTIFICATION_CHANNELS,
    DEFAULT_NOTIFICATION_SETTINGS,
    notificationSettingsSchema,
    notificationSettingsPatchSchema,
} from './notification.settings.js';
export type { NotificationChannel, NotificationSettings, NotificationSettingsPatch } from './notification.settings.js';

/**
 * Register {@link NotificationsService} into a registry. Expects
 * {@link SettingsService} and {@link Logger} to already be registered; call
 * before {@link registerPhotoSync} so the sync job can resolve it.
 */
export function registerNotifications(registry: InjectKitRegistry): void {
    registry
        .register(NotificationsService)
        .useFactory(container => new NotificationsService(container.get(SettingsService), container.get(Logger)))
        .asSingleton();
}
