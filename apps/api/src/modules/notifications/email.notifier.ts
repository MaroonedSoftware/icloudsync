import type { Notification, Notifier } from './notification.js';

/** SMTP connection + envelope settings for {@link EmailNotifier}. */
export interface EmailConfig {
    host: string;
    port: number;
    /** Use an implicit TLS connection (usually port 465). STARTTLS (587) leaves this false. */
    secure: boolean;
    /** SMTP auth username, if the server requires it. */
    username?: string;
    /** SMTP auth password, if the server requires it. */
    password?: string;
    /** Envelope `From` address. */
    from: string;
    /** Recipient (the admin) address. */
    to: string;
}

/** The minimal transport surface {@link EmailNotifier} needs; nodemailer satisfies it. */
export interface MailTransport {
    sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/**
 * Build a nodemailer SMTP transport from {@link EmailConfig}. Imported lazily so
 * the (optional) `nodemailer` dependency is only loaded when email is the
 * configured channel — a webhook-only or notifications-off deployment never
 * touches it.
 */
async function nodemailerTransport(config: EmailConfig): Promise<MailTransport> {
    const nodemailer = await import('nodemailer');
    const auth = config.username ? { user: config.username, pass: config.password } : undefined;
    return nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, auth }) as unknown as MailTransport;
}

/**
 * Delivers notifications as plain-text email over SMTP. The transport is
 * injectable so tests can assert on the sent message without a real server; in
 * production it defaults to a nodemailer SMTP transport built from
 * {@link EmailConfig}.
 */
export class EmailNotifier implements Notifier {
    readonly channel = 'email';
    private transportPromise?: Promise<MailTransport>;

    constructor(
        private readonly config: EmailConfig,
        transport?: MailTransport,
    ) {
        if (transport) this.transportPromise = Promise.resolve(transport);
    }

    private transport(): Promise<MailTransport> {
        this.transportPromise ??= nodemailerTransport(this.config);
        return this.transportPromise;
    }

    async send(notification: Notification): Promise<void> {
        const transport = await this.transport();
        await transport.sendMail({
            from: this.config.from,
            to: this.config.to,
            subject: notification.title,
            text: notification.message,
        });
    }
}
