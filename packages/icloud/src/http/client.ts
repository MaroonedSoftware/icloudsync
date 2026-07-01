import { CookieJar } from './cookies.js';

/** The subset of the global `fetch` signature this client depends on. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpResponse<T = unknown> {
    status: number;
    headers: Headers;
    /** Parsed JSON body, or `undefined` when the body is empty / not JSON. */
    data: T;
    /** Raw response body text. */
    text: string;
}

/** Extract `Set-Cookie` lines, preferring Node/undici's `getSetCookie()`. */
function getSetCookies(headers: Headers): string[] {
    const maybe = headers as unknown as { getSetCookie?: () => string[] };
    if (typeof maybe.getSetCookie === 'function') return maybe.getSetCookie();
    const raw = headers.get('set-cookie');
    return raw ? [raw] : [];
}

/**
 * A thin `fetch` wrapper that injects the cookie jar's `Cookie` header on the
 * way out, captures `Set-Cookie` on the way back, and JSON-encodes bodies. It
 * holds no auth state — callers supply their own headers per request.
 */
export class HttpClient {
    constructor(
        private readonly jar: CookieJar = new CookieJar(),
        private readonly fetchImpl: FetchLike = fetch,
    ) {}

    get cookies(): CookieJar {
        return this.jar;
    }

    async send<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<HttpResponse<T>> {
        const headers = new Headers(init.headers);
        const cookieHeader = this.jar.header(url);
        if (cookieHeader) headers.set('Cookie', cookieHeader);

        let body = init.body;
        if (init.json !== undefined) {
            headers.set('Content-Type', 'application/json');
            body = JSON.stringify(init.json);
        }

        const rest: RequestInit & { json?: unknown } = { ...init };
        delete rest.json;
        const response = await this.fetchImpl(url, { ...rest, headers, body });
        this.jar.ingest(getSetCookies(response.headers), url);

        const text = await response.text();
        let data: unknown;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = undefined;
            }
        }
        return { status: response.status, headers: response.headers, data: data as T, text };
    }

    /**
     * Cookie-aware fetch that returns the raw {@link Response} untouched — for
     * binary payloads (e.g. asset downloads) where reading the body as text
     * would corrupt it.
     */
    async raw(url: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers);
        const cookieHeader = this.jar.header(url);
        if (cookieHeader) headers.set('Cookie', cookieHeader);
        const response = await this.fetchImpl(url, { ...init, headers });
        this.jar.ingest(getSetCookies(response.headers), url);
        return response;
    }
}
