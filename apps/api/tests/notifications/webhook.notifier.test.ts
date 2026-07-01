import { describe, expect, it } from 'vitest';
import { WebhookNotifier, type FetchLike } from '../../src/modules/notifications/webhook.notifier.js';

describe('WebhookNotifier', () => {
    it('POSTs a JSON body with the notification fields plus Discord/Slack conveniences', async () => {
        const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
        const fetchImpl: FetchLike = async (url, init) => {
            calls.push({ url, init });
            return { ok: true, status: 200 };
        };
        const notifier = new WebhookNotifier('https://hook.example/x', fetchImpl);

        await notifier.send({ kind: 'reauth_required', title: 'Needs auth', message: 'me@icloud.com expired', account: 'me@icloud.com' });

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('https://hook.example/x');
        expect(calls[0]!.init.method).toBe('POST');
        expect(calls[0]!.init.headers['content-type']).toBe('application/json');
        const body = JSON.parse(calls[0]!.init.body);
        expect(body).toMatchObject({ kind: 'reauth_required', title: 'Needs auth', message: 'me@icloud.com expired', account: 'me@icloud.com' });
        // content (Discord) and text (Slack) carry the rendered message.
        expect(body.content).toContain('Needs auth');
        expect(body.text).toContain('me@icloud.com expired');
    });

    it('throws when the endpoint returns a non-2xx status', async () => {
        const notifier = new WebhookNotifier('https://hook.example/x', async () => ({ ok: false, status: 500 }));
        await expect(notifier.send({ kind: 'test', title: 't', message: 'm' })).rejects.toThrow('500');
    });
});
