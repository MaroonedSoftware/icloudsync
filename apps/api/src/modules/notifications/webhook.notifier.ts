import type { Notification, Notifier } from './notification.js';

/** The `fetch` surface {@link WebhookNotifier} needs; overridable in tests. */
export type FetchLike = (
    input: string,
    init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Delivers notifications by POSTing a JSON body to a configured URL. The payload
 * is deliberately generic (`{ kind, title, message, account }`) so it works with
 * anything that accepts a JSON webhook (ntfy, Gotify, a custom endpoint, an
 * automation runner). Discord/Slack expect a specific shape, so their incoming
 * webhooks are handled by also sending a `content`/`text` field carrying the
 * rendered text — enough for the common "post the message" case.
 */
export class WebhookNotifier implements Notifier {
    readonly channel = 'webhook';

    constructor(
        private readonly url: string,
        private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    ) {}

    async send(notification: Notification): Promise<void> {
        const text = `${notification.title}\n\n${notification.message}`;
        const body = JSON.stringify({
            kind: notification.kind,
            title: notification.title,
            message: notification.message,
            account: notification.account,
            // Convenience fields so Discord (`content`) and Slack (`text`) render out of the box.
            content: text,
            text,
        });

        const res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        if (!res.ok) throw new Error(`webhook responded ${res.status}`);
    }
}
