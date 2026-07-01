/**
 * A single admin-facing notification. Channel-agnostic: the {@link Notifier}
 * implementations render it into a webhook payload or an email. `account` names
 * the iCloud account the event concerns (when there is one); `kind` lets a
 * receiving webhook route or filter without parsing the human text.
 */
export interface Notification {
    /** Machine-readable event type, e.g. `reauth_required`. */
    kind: string;
    /** Short subject line (used as the email subject / embed title). */
    title: string;
    /** Human-readable body. */
    message: string;
    /** The iCloud account the notification concerns, when applicable. */
    account?: string;
}

/**
 * A delivery channel for admin {@link Notification}s. Implementations
 * ({@link WebhookNotifier}, {@link EmailNotifier}) are selected by config and
 * built by {@link NotificationsService}; each is responsible only for turning a
 * notification into a request/message and sending it.
 */
export interface Notifier {
    /** A short identifier for logs, e.g. `webhook` or `email`. */
    readonly channel: string;
    /** Deliver a notification, rejecting if the channel fails. */
    send(notification: Notification): Promise<void>;
}
