import { describe, expect, it } from 'vitest';
import { CookieJar } from '../src/http/cookies.js';

describe('CookieJar', () => {
    it('parses Set-Cookie and serializes a Cookie header for matching requests', () => {
        const jar = new CookieJar();
        jar.ingest(
            ['X-APPLE-WEBAUTH-TOKEN=abc123; Domain=.icloud.com; Path=/; Secure; HttpOnly', 'aasp=zzz; Path=/'],
            'https://setup.icloud.com/setup/ws/1/accountLogin',
        );

        const header = jar.header('https://p01-ckdatabasews.icloud.com/database/1');
        expect(header).toContain('X-APPLE-WEBAUTH-TOKEN=abc123');
        // `aasp` defaulted its domain to the request host, so it does not match a different host.
        expect(header).not.toContain('aasp=');
    });

    it('does not send Secure cookies over http', () => {
        const jar = new CookieJar();
        jar.ingest(['s=1; Domain=icloud.com; Path=/; Secure'], 'https://icloud.com/');
        expect(jar.header('http://icloud.com/')).toBe('');
        expect(jar.header('https://icloud.com/')).toBe('s=1');
    });

    it('honors path scoping', () => {
        const jar = new CookieJar();
        jar.ingest(['scoped=1; Domain=icloud.com; Path=/setup'], 'https://icloud.com/setup');
        expect(jar.header('https://icloud.com/setup/ws')).toBe('scoped=1');
        expect(jar.header('https://icloud.com/other')).toBe('');
    });

    it('treats an already-expired Set-Cookie as a deletion', () => {
        const jar = new CookieJar();
        jar.ingest(['gone=1; Domain=icloud.com; Path=/'], 'https://icloud.com/');
        jar.ingest(['gone=1; Domain=icloud.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], 'https://icloud.com/');
        expect(jar.header('https://icloud.com/')).toBe('');
    });

    it('round-trips through JSON', () => {
        const jar = new CookieJar();
        jar.ingest(['t=value; Domain=icloud.com; Path=/'], 'https://icloud.com/');
        const restored = CookieJar.fromJSON(jar.toJSON());
        expect(restored.header('https://icloud.com/')).toBe('t=value');
    });
});
