import { describe, expect, it } from 'vitest';
import { EmailNotifier, type EmailConfig, type MailTransport } from '../../src/modules/notifications/email.notifier.js';

const config: EmailConfig = { host: 'smtp.example', port: 587, secure: false, from: 'bot@example', to: 'admin@example' };

describe('EmailNotifier', () => {
    it('sends the notification as a plain-text email via the injected transport', async () => {
        const sent: Array<{ from: string; to: string; subject: string; text: string }> = [];
        const transport: MailTransport = {
            sendMail: async message => {
                sent.push(message);
                return {};
            },
        };
        const notifier = new EmailNotifier(config, transport);

        await notifier.send({ kind: 'reauth_required', title: 'Needs auth', message: 'me@icloud.com expired', account: 'me@icloud.com' });

        expect(sent).toEqual([{ from: 'bot@example', to: 'admin@example', subject: 'Needs auth', text: 'me@icloud.com expired' }]);
    });

    it('propagates transport failures', async () => {
        const transport: MailTransport = { sendMail: async () => Promise.reject(new Error('smtp down')) };
        const notifier = new EmailNotifier(config, transport);
        await expect(notifier.send({ kind: 'test', title: 't', message: 'm' })).rejects.toThrow('smtp down');
    });
});
