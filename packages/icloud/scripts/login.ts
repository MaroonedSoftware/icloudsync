/**
 * Manual end-to-end login smoke test. NOT part of the automated suite.
 *
 *   pnpm --filter @icloudsync/icloud login:live
 *
 * Credentials come from APPLE_ID / APPLE_PASSWORD when set, otherwise the script
 * prompts for them (the password is read without echo). Prompts for the 2FA
 * security code if required, then prints the resolved dsid and service URLs.
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { ICloudClient } from '../src/index.js';

// A single shared readline interface for the whole script. Creating and closing
// a separate interface per prompt pauses stdin between prompts, which makes the
// next prompt resolve empty instead of waiting for input.
const rl = createInterface({ input: stdin, output: stdout });

async function ask(question: string): Promise<string> {
    return (await rl.question(question)).trim();
}

/** Prompt without echoing keystrokes — for the password. */
async function askHidden(question: string): Promise<string> {
    stdout.write(question);
    // Suppress everything readline tries to echo while the password is typed.
    const originalWrite = stdout.write.bind(stdout);
    (stdout as unknown as { write: () => boolean }).write = () => true;
    try {
        return (await rl.question('')).trim();
    } finally {
        (stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
        originalWrite('\n');
    }
}

async function main(): Promise<void> {
    const accountName = process.env.APPLE_ID ?? (await ask('Apple ID: '));
    if (!accountName) {
        console.error('An Apple ID is required.');
        process.exitCode = 1;
        return;
    }

    const client = new ICloudClient({ accountName, debug: Boolean(process.env.ICLOUD_DEBUG) });

    const wasRestored = await client.restore();
    if (wasRestored) {
        console.log('Restored an existing authenticated session.');
    } else {
        // Only ask for the password when a fresh login is actually needed.
        const password = process.env.APPLE_PASSWORD ?? (await askHidden('Password: '));
        if (!password) {
            console.error('A password is required.');
            process.exitCode = 1;
            return;
        }
        const result = await client.login(password);
        if (result.state === 'mfaRequired') {
            const options = await client.getTwoFactorOptions();
            if (options.trustedDeviceCount > 0) {
                console.log(`\nA 6-digit code was pushed to ${options.trustedDeviceCount} trusted device(s) — check your iPhone/iPad/Mac for the "Sign In Requested" popup.`);
                const code = await ask('Enter the code from your device: ');
                await client.submitSecurityCode(code);
            } else if (options.phoneNumbers.length > 0) {
                const phone = options.phoneNumbers[0]!;
                console.log(`\nNo trusted devices. Sending an SMS code to ${phone.number ?? 'your trusted phone'}…`);
                await client.requestPhoneCode(phone.id);
                const code = await ask('Enter the SMS code: ');
                await client.submitPhoneCode(code, phone.id);
            } else {
                console.error('No trusted devices or phone numbers are available for 2FA on this account.');
                process.exitCode = 1;
                return;
            }
        }
    }

    console.log('\nAuthenticated:', client.isAuthenticated);
    console.log('dsid:', client.dsid);
    console.log('\nDiscovered services:');
    for (const [name, entry] of Object.entries(client.webservices ?? {})) {
        console.log(`  ${name.padEnd(20)} ${entry.url}`);
    }
}

main()
    .catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
            console.error('\nstdin closed before all prompts were answered. Run this in an interactive terminal, or set APPLE_ID / APPLE_PASSWORD in the environment.');
        } else {
            console.error(error);
        }
        process.exitCode = 1;
    })
    .finally(() => rl.close());
