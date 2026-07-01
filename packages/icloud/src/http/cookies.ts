/**
 * Minimal cookie jar — enough to persist and replay iCloud's session cookies
 * (`X-APPLE-WEBAUTH-*`, `aasp`, etc.) across requests and restarts. Not a full
 * RFC 6265 implementation; it covers name/value, domain, path, expiry, and the
 * `Secure` flag, which is all Apple's endpoints rely on.
 */

export interface StoredCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    /** Absolute expiry in epoch seconds; omitted for session cookies. */
    expires?: number;
    secure?: boolean;
    httpOnly?: boolean;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const keyOf = (c: StoredCookie): string => `${c.domain}|${c.path}|${c.name}`;

/** A host matches a cookie domain if it equals it or is a sub-domain of it. */
function domainMatch(host: string, cookieDomain: string): boolean {
    const d = cookieDomain.toLowerCase();
    const h = host.toLowerCase();
    return h === d || h.endsWith('.' + d);
}

function parseSetCookie(line: string, url: URL): StoredCookie | null {
    const segments = line.split(';');
    const first = (segments[0] ?? '').trim();
    const eq = first.indexOf('=');
    if (eq < 0) return null;
    const name = first.slice(0, eq).trim();
    if (!name) return null;
    const value = first.slice(eq + 1).trim();

    const cookie: StoredCookie = { name, value, domain: url.hostname, path: '/' };
    for (const segment of segments.slice(1)) {
        const part = segment.trim();
        if (!part) continue;
        const idx = part.indexOf('=');
        const attr = (idx < 0 ? part : part.slice(0, idx)).trim().toLowerCase();
        const attrValue = idx < 0 ? '' : part.slice(idx + 1).trim();
        switch (attr) {
            case 'domain':
                if (attrValue) cookie.domain = attrValue.replace(/^\./, '');
                break;
            case 'path':
                if (attrValue) cookie.path = attrValue;
                break;
            case 'secure':
                cookie.secure = true;
                break;
            case 'httponly':
                cookie.httpOnly = true;
                break;
            case 'max-age': {
                const maxAge = parseInt(attrValue, 10);
                if (!Number.isNaN(maxAge)) cookie.expires = nowSeconds() + maxAge;
                break;
            }
            case 'expires':
                if (cookie.expires === undefined) {
                    const ts = Date.parse(attrValue);
                    if (!Number.isNaN(ts)) cookie.expires = Math.floor(ts / 1000);
                }
                break;
        }
    }
    return cookie;
}

export class CookieJar {
    private readonly cookies = new Map<string, StoredCookie>();

    constructor(initial?: StoredCookie[]) {
        if (initial) for (const c of initial) this.cookies.set(keyOf(c), c);
    }

    static fromJSON(cookies: StoredCookie[]): CookieJar {
        return new CookieJar(cookies);
    }

    /** Snapshot of all stored cookies, suitable for JSON persistence. */
    toJSON(): StoredCookie[] {
        return [...this.cookies.values()];
    }

    /** Absorb `Set-Cookie` header lines from a response to `requestUrl`. */
    ingest(setCookieLines: string[], requestUrl: string): void {
        const url = new URL(requestUrl);
        for (const line of setCookieLines) {
            const cookie = parseSetCookie(line, url);
            if (!cookie) continue;
            // An expired cookie (e.g. value cleared by the server) is a deletion.
            if (cookie.expires !== undefined && cookie.expires <= nowSeconds()) {
                this.cookies.delete(keyOf(cookie));
                continue;
            }
            this.cookies.set(keyOf(cookie), cookie);
        }
    }

    /** Build the `Cookie` request header for `requestUrl`. */
    header(requestUrl: string): string {
        const url = new URL(requestUrl);
        const now = nowSeconds();
        const matches: StoredCookie[] = [];
        for (const cookie of this.cookies.values()) {
            if (cookie.expires !== undefined && cookie.expires <= now) continue;
            if (!domainMatch(url.hostname, cookie.domain)) continue;
            if (!url.pathname.startsWith(cookie.path)) continue;
            if (cookie.secure && url.protocol !== 'https:') continue;
            matches.push(cookie);
        }
        return matches.map(c => `${c.name}=${c.value}`).join('; ');
    }
}
