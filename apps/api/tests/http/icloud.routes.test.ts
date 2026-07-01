import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@maroonedsoftware/logger';
import { AuthenticationError, InvalidSecurityCodeError, type LoginResult, type TwoFactorOptions } from '@icloudsync/icloud';
import { createRegistry } from 'injectkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeServer } from '../_helpers/server.js';
import { registerBodyParser } from '../../src/modules/http/body.parser.js';
import { createApiApp } from '../../src/modules/http/server.js';
import { ICloudService, type AccountStatus } from '../../src/modules/icloud/icloud.service.js';

/** Quiet logger so the error middleware doesn't spam the test output. */
const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} } as Logger;

const ACCOUNT = 'me@icloud.com';

/**
 * Configurable stand-in for {@link ICloudService}. Each auth method either
 * returns a canned {@link LoginResult} or throws the configured error, and
 * records the account it was called with, so the per-account routes can be
 * exercised without touching Apple's servers.
 */
class FakeICloud {
    authenticated = false;
    statusImpl: () => Promise<AccountStatus[]> = async () => [{ account: ACCOUNT, authenticated: this.authenticated }];
    loginImpl: () => Promise<LoginResult> = async () => ({ state: 'mfaRequired' });
    codeImpl: () => Promise<LoginResult> = async () => ({ state: 'authenticated' });
    optionsImpl: () => Promise<TwoFactorOptions> = async () => ({ trustedDeviceCount: 1, phoneNumbers: [{ id: 2, number: '+1 (•••) •••-4242' }] });
    phoneCalls: Array<{ account: string; code?: string; phoneId: number }> = [];
    deviceCodeRequests: string[] = [];
    lastLoginAccount?: string;
    loggedOut?: string;
    removed?: string;

    accountsStatus(): Promise<AccountStatus[]> {
        return this.statusImpl();
    }
    isAuthenticated(_account: string): boolean {
        return this.authenticated;
    }
    login(account: string): Promise<LoginResult> {
        this.lastLoginAccount = account;
        return this.loginImpl();
    }
    submitSecurityCode(): Promise<LoginResult> {
        return this.codeImpl();
    }
    getTwoFactorOptions(): Promise<TwoFactorOptions> {
        return this.optionsImpl();
    }
    requestDeviceCode(account: string): Promise<void> {
        this.deviceCodeRequests.push(account);
        return Promise.resolve();
    }
    requestPhoneCode(account: string, phoneId: number): Promise<void> {
        this.phoneCalls.push({ account, phoneId });
        return Promise.resolve();
    }
    submitPhoneCode(account: string, code: string, phoneId: number): Promise<LoginResult> {
        this.phoneCalls.push({ account, code, phoneId });
        return this.codeImpl();
    }
    logout(account: string): Promise<void> {
        this.loggedOut = account;
        return Promise.resolve();
    }
    remove(account: string): Promise<void> {
        this.removed = account;
        return Promise.resolve();
    }
}

describe('icloud auth routes', () => {
    let server: Server;
    let base: string;
    let fake: FakeICloud;

    beforeEach(() => {
        fake = new FakeICloud();
        const registry = createRegistry();
        registry.register(Logger).useInstance(silentLogger);
        registerBodyParser(registry);
        registry.register(ICloudService).useInstance(fake as unknown as ICloudService);

        server = createApiApp(registry.build()).listen(0);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(() => closeServer(server));

    const acct = `/icloud/accounts/${ACCOUNT}`;
    const post = (path: string, body?: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
        fetch(`${base}${path}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });

    it('lists the registered accounts with auth status', async () => {
        const res = await fetch(`${base}/icloud/accounts`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ accounts: [{ account: ACCOUNT, authenticated: false }] });
    });

    it('reports one account status without auth', async () => {
        const res = await fetch(`${base}${acct}/status`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ account: ACCOUNT, authenticated: false });
    });

    it('returns the login outcome (mfa required) and passes the account through', async () => {
        const res = await post(`${acct}/login`, { password: 'hunter2' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ state: 'mfaRequired' });
        expect(fake.lastLoginAccount).toBe(ACCOUNT);
    });

    it('rejects a login with an empty password with 400', async () => {
        const res = await post(`${acct}/login`, { password: '' });
        expect(res.status).toBe(400);
    });

    it('rejects a login for a too-short account path with 400', async () => {
        const res = await post('/icloud/accounts/ab/login', { password: 'hunter2' });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ details: { reason: 'account_required' } });
    });

    it('completes 2FA and returns authenticated', async () => {
        const res = await post(`${acct}/2fa`, { code: '123456' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ state: 'authenticated' });
    });

    it('maps a rejected 2FA code to 401 with a machine-readable reason', async () => {
        fake.codeImpl = async () => {
            throw new InvalidSecurityCodeError('nope');
        };
        const res = await post(`${acct}/2fa`, { code: '000000' });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ statusCode: 401, details: { reason: 'invalid_security_code' } });
    });

    it('maps a bad password to 401', async () => {
        fake.loginImpl = async () => {
            throw new AuthenticationError('bad creds');
        };
        const res = await post(`${acct}/login`, { password: 'wrong' });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ details: { reason: 'authentication_failed' } });
    });

    it('rejects a non-JSON content type with 415', async () => {
        const res = await post(`${acct}/login`, 'password=x', { 'content-type': 'text/plain' });
        expect(res.status).toBe(415);
    });

    it('reports the 2FA delivery options', async () => {
        const res = await fetch(`${base}${acct}/2fa/options`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ trustedDeviceCount: 1, phoneNumbers: [{ id: 2, number: '+1 (•••) •••-4242' }] });
    });

    it('pushes a code to the trusted devices', async () => {
        const res = await post(`${acct}/2fa/device`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ requested: true });
        expect(fake.deviceCodeRequests).toEqual([ACCOUNT]);
    });

    it('requests an SMS code for a phone number', async () => {
        const res = await post(`${acct}/2fa/phone`, { phoneId: 2 });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ requested: true, phoneId: 2 });
        expect(fake.phoneCalls).toEqual([{ account: ACCOUNT, phoneId: 2 }]);
    });

    it('verifies an SMS code and returns authenticated', async () => {
        const res = await post(`${acct}/2fa/phone/verify`, { phoneId: 2, code: '123456' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ state: 'authenticated' });
        expect(fake.phoneCalls).toEqual([{ account: ACCOUNT, phoneId: 2, code: '123456' }]);
    });

    it('rejects a phone verify missing the phoneId with 400', async () => {
        const res = await post(`${acct}/2fa/phone/verify`, { code: '123456' });
        expect(res.status).toBe(400);
    });

    it('logs out an account, keeping it registered', async () => {
        const res = await post(`${acct}/logout`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ state: 'loggedOut' });
        expect(fake.loggedOut).toBe(ACCOUNT);
    });

    it('removes an account entirely', async () => {
        const res = await fetch(`${base}${acct}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ state: 'removed' });
        expect(fake.removed).toBe(ACCOUNT);
    });

    it('returns 404 for an unknown route', async () => {
        const res = await fetch(`${base}/nope`);
        expect(res.status).toBe(404);
    });
});
