import { describe, expect, it } from 'vitest';
import { ICloudClient } from '../src/index.js';
import { MemorySessionStore } from '../src/session/memory.session.store.js';

interface RecordedCall {
    url: string;
    method: string;
    headers: Headers;
    body: Record<string, unknown> | undefined;
}

const VALID_B = Buffer.alloc(256, 0x12).toString('base64');
const SALT = Buffer.alloc(16, 0x42).toString('base64');

/**
 * A scripted Apple GSA + iCloud setup server. `/signin/complete` returns 200
 * when the request carries a trust token (replaying a remembered device) and
 * 409 (2FA required) otherwise — so the same mock drives both the first login
 * and the trust-token short-circuit.
 */
function makeMockFetch() {
    const calls: RecordedCall[] = [];

    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        calls.push({ url, method, headers, body });

        if (url.includes('/signin/init')) {
            return new Response(JSON.stringify({ salt: SALT, b: VALID_B, c: 'challenge-c', iteration: 1000, protocol: 's2k' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', scnt: 'scnt-1', 'X-Apple-ID-Session-Id': 'sid-1' },
            });
        }
        if (url.includes('/signin/complete')) {
            const trustTokens = (body?.trustTokens as string[] | undefined) ?? [];
            if (trustTokens.length > 0) {
                return new Response(null, {
                    status: 200,
                    headers: { 'X-Apple-Session-Token': 'session-token-remembered', 'X-Apple-ID-Account-Country': 'USA' },
                });
            }
            return new Response(null, { status: 409, headers: { scnt: 'scnt-2', 'X-Apple-ID-Session-Id': 'sid-1' } });
        }
        if (url.includes('/verify/trusteddevice/securitycode')) {
            return new Response(null, { status: 204 });
        }
        if (url.includes('/verify/trusteddevice')) {
            return new Response(null, { status: 200 });
        }
        if (url.includes('/2sv/trust')) {
            return new Response(null, {
                status: 200,
                headers: { 'X-Apple-TwoSV-Trust-Token': 'trust-token-xyz', 'X-Apple-Session-Token': 'session-token-after-trust' },
            });
        }
        if (url.includes('/accountLogin')) {
            return new Response(
                JSON.stringify({
                    dsInfo: { dsid: 123456789, fullName: 'Test User', appleId: 'me@icloud.com', hsaVersion: 2 },
                    webservices: {
                        ckdatabasews: { url: 'https://p01-ckdatabasews.icloud.com:443', status: 'active' },
                        drivews: { url: 'https://p01-drivews.icloud.com:443', status: 'active' },
                    },
                }),
                {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Set-Cookie': 'X-APPLE-WEBAUTH-TOKEN=webauth123; Domain=.icloud.com; Path=/; Secure',
                    },
                },
            );
        }
        return new Response('not found', { status: 404 });
    };

    return { fetchImpl, calls };
}

describe('ICloudClient auth flow', () => {
    it('handles the SRP -> 2FA -> trust -> session-establishment sequence', async () => {
        const { fetchImpl, calls } = makeMockFetch();
        const sessionStore = new MemorySessionStore();
        const client = new ICloudClient({ accountName: 'me@icloud.com', sessionStore, fetch: fetchImpl });

        const result = await client.login('s3cret');
        expect(result).toEqual({ state: 'mfaRequired' });
        expect(client.isAuthenticated).toBe(false);

        const finished = await client.submitSecurityCode('123456');
        expect(finished).toEqual({ state: 'authenticated' });
        expect(client.isAuthenticated).toBe(true);
        expect(client.dsid).toBe('123456789');
        expect(client.serviceUrl('ckdatabasews')).toBe('https://p01-ckdatabasews.icloud.com:443');

        // The first sign-in carried the widget key and an empty trustTokens list.
        const init = calls.find(c => c.url.includes('/signin/init'));
        expect(init?.headers.get('X-Apple-Widget-Key')).toBe('d39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d');
        const firstComplete = calls.find(c => c.url.includes('/signin/complete'));
        expect(firstComplete?.body?.trustTokens).toEqual([]);

        // The trust token and a service cookie were persisted.
        const raw = await sessionStore.read('session-me@icloud.com.json');
        const persisted = JSON.parse(new TextDecoder().decode(raw!));
        expect(persisted.trustToken).toBe('trust-token-xyz');
        expect(persisted.dsid).toBe('123456789');
        expect(persisted.cookies.some((c: { name: string }) => c.name === 'X-APPLE-WEBAUTH-TOKEN')).toBe(true);
    });

    it('requests a trusted-device code via GET /verify/trusteddevice', async () => {
        const { fetchImpl, calls } = makeMockFetch();
        const client = new ICloudClient({ accountName: 'me@icloud.com', sessionStore: new MemorySessionStore(), fetch: fetchImpl });

        expect((await client.login('s3cret')).state).toBe('mfaRequired');
        await client.requestDeviceCode();

        const request = calls.find(c => c.url.includes('/verify/trusteddevice') && !c.url.includes('securitycode'));
        expect(request?.method).toBe('GET');
        // The rolling scnt/session-id captured from the 409 are echoed on the request.
        expect(request?.headers.get('X-Apple-ID-Session-Id')).toBe('sid-1');
        expect(request?.headers.get('scnt')).toBe('scnt-2');
    });

    it('skips 2FA on a later login using the persisted trust token', async () => {
        const { fetchImpl, calls } = makeMockFetch();
        const sessionStore = new MemorySessionStore();

        // First login establishes and persists the trust token.
        const first = new ICloudClient({ accountName: 'me@icloud.com', sessionStore, fetch: fetchImpl });
        expect((await first.login('s3cret')).state).toBe('mfaRequired');
        await first.submitSecurityCode('123456');

        // A fresh client over the same store authenticates without a security code.
        const second = new ICloudClient({ accountName: 'me@icloud.com', sessionStore, fetch: fetchImpl });
        const result = await second.login('s3cret');
        expect(result).toEqual({ state: 'authenticated' });
        expect(second.isAuthenticated).toBe(true);

        // The remembered-device sign-in sent the stored trust token.
        const completes = calls.filter(c => c.url.includes('/signin/complete'));
        const lastComplete = completes[completes.length - 1];
        expect(lastComplete?.body?.trustTokens).toEqual(['trust-token-xyz']);
        // No second security-code submission was needed.
        expect(calls.filter(c => c.url.includes('/verify/trusteddevice/securitycode'))).toHaveLength(1);
    });

    it('reports invalid credentials as an AuthenticationError', async () => {
        const fetchImpl = async (url: string): Promise<Response> => {
            if (url.includes('/signin/init')) {
                return new Response(JSON.stringify({ salt: SALT, b: VALID_B, c: 'c', iteration: 1000, protocol: 's2k' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(null, { status: 401 });
        };
        const client = new ICloudClient({ accountName: 'me@icloud.com', sessionStore: new MemorySessionStore(), fetch: fetchImpl });
        await expect(client.login('wrong')).rejects.toThrow(/Invalid Apple ID or password/);
    });
});
