import { describe, expect, it } from 'vitest';
import {
    DEFAULT_NOTIFICATION_SETTINGS,
    NOTIFICATION_CHANNELS,
    notificationSettingsPatchSchema,
    notificationSettingsSchema,
} from '../../src/modules/notifications/notification.settings.js';

describe('notificationSettingsSchema', () => {
    it('applies built-in defaults for an empty object', () => {
        expect(notificationSettingsSchema.parse({})).toEqual({ channel: 'none', throttleHours: 24 });
    });

    it('exposes the same defaults via DEFAULT_NOTIFICATION_SETTINGS', () => {
        expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual({ channel: 'none', throttleHours: 24 });
    });

    it('accepts every declared channel', () => {
        for (const channel of NOTIFICATION_CHANNELS) {
            expect(notificationSettingsSchema.parse({ channel }).channel).toBe(channel);
        }
    });

    it('rejects an unknown channel', () => {
        expect(() => notificationSettingsSchema.parse({ channel: 'sms' })).toThrow();
    });

    it('rejects a negative throttle and one beyond the 30-day cap', () => {
        expect(() => notificationSettingsSchema.parse({ throttleHours: -1 })).toThrow();
        expect(() => notificationSettingsSchema.parse({ throttleHours: 24 * 30 + 1 })).toThrow();
    });

    it('accepts the throttle boundary values', () => {
        expect(notificationSettingsSchema.parse({ throttleHours: 0 }).throttleHours).toBe(0);
        expect(notificationSettingsSchema.parse({ throttleHours: 24 * 30 }).throttleHours).toBe(24 * 30);
    });

    it('rejects a non-URL webhookUrl but accepts a valid one', () => {
        expect(() => notificationSettingsSchema.parse({ webhookUrl: 'not-a-url' })).toThrow();
        expect(notificationSettingsSchema.parse({ webhookUrl: 'https://hook.example/x' }).webhookUrl).toBe('https://hook.example/x');
    });

    it('defaults email.secure to false and keeps required SMTP fields', () => {
        const parsed = notificationSettingsSchema.parse({
            channel: 'email',
            email: { host: 'smtp.example', port: 587, from: 'bot@example', to: 'admin@example' },
        });
        expect(parsed.email).toEqual({ host: 'smtp.example', port: 587, secure: false, from: 'bot@example', to: 'admin@example' });
    });

    it('rejects an out-of-range SMTP port', () => {
        const email = { host: 'smtp.example', port: 70000, from: 'bot@example', to: 'admin@example' };
        expect(() => notificationSettingsSchema.parse({ channel: 'email', email })).toThrow();
    });

    it('rejects an email config missing required fields', () => {
        expect(() => notificationSettingsSchema.parse({ channel: 'email', email: { host: 'smtp.example', port: 587 } })).toThrow();
    });

    it('allows channel-irrelevant details to be stored (email set while channel is none)', () => {
        const parsed = notificationSettingsSchema.parse({
            channel: 'none',
            email: { host: 'smtp.example', port: 587, from: 'bot@example', to: 'admin@example' },
        });
        expect(parsed.channel).toBe('none');
        expect(parsed.email?.host).toBe('smtp.example');
    });
});

describe('notificationSettingsPatchSchema', () => {
    it('accepts a partial patch with only some fields set', () => {
        const parsed = notificationSettingsPatchSchema.parse({ webhookUrl: 'https://hook.example/x' });
        expect(parsed.webhookUrl).toBe('https://hook.example/x');
    });

    it('leaves optional-without-default fields absent on an empty patch', () => {
        // Zod .partial() keeps field-level .default()s, so channel/throttleHours still
        // fill in; only the genuinely optional webhookUrl/email stay absent.
        const parsed = notificationSettingsPatchSchema.parse({});
        expect(parsed.webhookUrl).toBeUndefined();
        expect(parsed.email).toBeUndefined();
        expect(parsed).toMatchObject({ channel: 'none', throttleHours: 24 });
    });

    it('still enforces field-level validation on the fields present', () => {
        expect(() => notificationSettingsPatchSchema.parse({ channel: 'sms' })).toThrow();
        expect(() => notificationSettingsPatchSchema.parse({ throttleHours: -5 })).toThrow();
    });
});
