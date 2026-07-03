import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@maroonedsoftware/logger';
import { AuthenticationError, InvalidSecurityCodeError, type LoginResult, type TwoFactorOptions } from '@icloudsync/icloud';
import { createRegistry } from 'injectkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeServer } from '../_helpers/server.js';
import { registerBodyParser } from '../../src/modules/http/body.parser.js';
import { createApiApp } from '../../src/modules/http/server.js';
import { ICloudService, type AccountLoginResult, type AccountStatus } from '../../src/modules/icloud/icloud.service.js';

/** Quiet logger so the error middleware doesn't spam the test output. */
const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} } as Logger;

const ACCOUNT = 'me@icloud.com';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';

/**
 * Configurable stand-in for {@link ICloudService}. Each auth method either
 * returns a canned {@link LoginResult} or throws the configured error, and
 * records the account id it was called with, so the per-account routes can be
 * exercised without touching Apple's servers.
 */
class FakeICloud {
    authenticated = false;
    statusImpl: () => Promise<AccountStatus[]> = async () => [{ id: ACCOUNT_ID, account: ACCOUNT, authenticated: this.authenticated }];
    loginImpl: () => Promise<LoginResult> = async () => ({ state: 'mfaRequired' });
    codeImpl: () => Promise<LoginResult> = async () => ({ state: 'authenticated' });
    optionsImpl: () => Promise<TwoFactorOptions> = async () => ({ trustedDeviceCount: 1, phoneNumbers: [{ id: 2, number: '+1 (•••) •••-4242' }] });
    phoneCalls: Array<{ id: string; code?: string; phoneId: number }> = [];
    deviceCodeRequests: string[] = [];
    lastLoginAccount?: string;
    loggedOut?: string;
    removed?: string;

    accountsStatus(): Promise<AccountStatus[]> {
        return this.statusImpl();
    }
    isAuthenticated(_id: string): boolean {
        return this.authenticated;
    }
    async login(accountName: string): Promise<AccountLoginResult> {
        this.lastLoginAccount = accountName;
        return { ...(await this.loginImpl()), id: ACCOUNT_ID };
    }
    submitSecurityCode(): Promise<LoginResult> {
        return this.codeImpl();
    }
    getTwoFactorOptions(): Promise<TwoFactorOptions> {
        return this.optionsImpl();
    }
    requestDeviceCode(id: string): Promise<void> {
        this.deviceCodeRequests.push(id);
        return Promise.resolve();
    }
    requestPhoneCode(id: string, phoneId: number): Promise<void> {
        this.phoneCalls.push({ id, phoneId });
        return Promise.resolve();
    }
    submitPhoneCode(id: string, code: string, phoneId: number): Promise<LoginResult> {
        this.phoneCalls.push({ id, code, phoneId });
        return this.codeImpl();
    }
    logout(id: string): Promise<void> {
        this.loggedOut = id;
        return Promise.resolve();
    }
    remove(id: string): Promise<void> {
        this.removed = id;
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

    const acct = `/icloud/accounts/${ACCOUNT_ID}`;
    const post = (path: string, body?: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
        fetch(`${base}${path}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });

    it('lists the registered accounts with id + auth status', async () => {
        const res = await fetch(`${base}/icloud/accounts`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ accounts: [{ id: ACCOUNT_ID, account: ACCOUNT, authenticated: false }] });
    });

    it('reports one account status by id', async () => {
        const res = await fetch(`${base}${acct}/status`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: ACCOUNT_ID, authenticated: false });
    });

    it('creates an account and returns its id + the login outcome (mfa required)', async () => {
        const res = await post('/icloud/accounts', { accountName: ACCOUNT, password: 'hunter2' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: ACCOUNT_ID, state: 'mfaRequired' });
        expect(fake.lastLoginAccount).toBe(ACCOUNT);
    });

    it('rejects a create with an empty password with 400', async () => {
        const res = await post('/icloud/accounts', { accountName: ACCOUNT, password: '' });
        expect(res.status).toBe(400);
    });

    it('rejects a create with a too-short accountName with 400', async () => {
        const res = await post('/icloud/accounts', { accountName: 'ab', password: 'hunter2' });
        expect(res.status).toBe(400);
    });

    it('rejects a non-UUID account path with 400', async () => {
        const res = await fetch(`${base}/icloud/accounts/not-a-uuid/status`);
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
        const res = await post('/icloud/accounts', { accountName: ACCOUNT, password: 'wrong' });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ details: { reason: 'authentication_failed' } });
    });

    it('rejects a non-JSON content type with 415', async () => {
        const res = await post('/icloud/accounts', 'password=x', { 'content-type': 'text/plain' });
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
        expect(fake.deviceCodeRequests).toEqual([ACCOUNT_ID]);
    });

    it('requests an SMS code for a phone number', async () => {
        const res = await post(`${acct}/2fa/phone`, { phoneId: 2 });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ requested: true, phoneId: 2 });
        expect(fake.phoneCalls).toEqual([{ id: ACCOUNT_ID, phoneId: 2 }]);
    });

    it('verifies an SMS code and returns authenticated', async () => {
        const res = await post(`${acct}/2fa/phone/verify`, { phoneId: 2, code: '123456' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ state: 'authenticated' });
        expect(fake.phoneCalls).toEqual([{ id: ACCOUNT_ID, phoneId: 2, code: '123456' }]);
    });

    it('rejects a phone verify missing the phoneId with 400', async () => {
        const res = await post(`${acct}/2fa/phone/verify`, { code: '123456' });
        expect(res.status).toBe(400);
    });

    it('logs out an account, keeping it registered', async () => {
        const res = await post(`${acct}/logout`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ state: 'loggedOut' });
        expect(fake.loggedOut).toBe(ACCOUNT_ID);
    });

    it('removes an account entirely', async () => {
        const res = await fetch(`${base}${acct}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ state: 'removed' });
        expect(fake.removed).toBe(ACCOUNT_ID);
    });

    it('returns 404 for an unknown route', async () => {
        const res = await fetch(`${base}/nope`);
        expect(res.status).toBe(404);
    });
});
