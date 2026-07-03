import { RateLimitError } from '../errors.js';
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

/** Tunables for the automatic HTTP 429 (Too Many Requests) retry behaviour. */
export interface RetryOptions {
    /** Retry attempts made after the first 429 before giving up. Set `0` to fail fast. Default `3`. */
    maxRetries?: number;
    /** Backoff for the first retry when the server sends no `Retry-After`; doubles each attempt. Default `1000`ms. */
    baseDelayMs?: number;
    /** Upper bound on any single wait, including a server-supplied `Retry-After`. Default `60000`ms. */
    maxDelayMs?: number;
    /** Sleep implementation; injectable so tests need not wait on real timers. */
    sleep?: (ms: number) => Promise<void>;
}

type ResolvedRetry = Required<RetryOptions>;

const DEFAULT_RETRY: ResolvedRetry = {
    maxRetries: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
};

/** Extract `Set-Cookie` lines, preferring Node/undici's `getSetCookie()`. */
function getSetCookies(headers: Headers): string[] {
    const maybe = headers as unknown as { getSetCookie?: () => string[] };
    if (typeof maybe.getSetCookie === 'function') return maybe.getSetCookie();
    const raw = headers.get('set-cookie');
    return raw ? [raw] : [];
}

/**
 * Parse an HTTP `Retry-After` header into a wait in milliseconds. The header is
 * either a non-negative number of delta-seconds or an HTTP-date. Returns
 * `undefined` when the header is absent or unparseable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
    const when = Date.parse(trimmed);
    if (Number.isNaN(when)) return undefined;
    return Math.max(0, when - now);
}

/**
 * A thin `fetch` wrapper that injects the cookie jar's `Cookie` header on the
 * way out, captures `Set-Cookie` on the way back, and JSON-encodes bodies. It
 * holds no auth state — callers supply their own headers per request.
 *
 * Requests that come back HTTP 429 are retried automatically, honouring the
 * server's `Retry-After` header (falling back to exponential backoff). If the
 * request is still throttled after {@link RetryOptions.maxRetries}, a
 * {@link RateLimitError} is thrown so callers can back off at a higher level.
 */
export class HttpClient {
    private readonly retry: ResolvedRetry;

    constructor(
        private readonly jar: CookieJar = new CookieJar(),
        private readonly fetchImpl: FetchLike = fetch,
        retry: RetryOptions = {},
    ) {
        this.retry = { ...DEFAULT_RETRY, ...retry };
    }

    get cookies(): CookieJar {
        return this.jar;
    }

    async send<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<HttpResponse<T>> {
        const headers = new Headers(init.headers);

        let body = init.body;
        if (init.json !== undefined) {
            headers.set('Content-Type', 'application/json');
            body = JSON.stringify(init.json);
        }

        const rest: RequestInit & { json?: unknown } = { ...init };
        delete rest.json;
        const response = await this.dispatch(url, { ...rest, headers, body });

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
        return this.dispatch(url, init);
    }

    /**
     * Perform the actual fetch, replaying cookies and capturing `Set-Cookie` on
     * each attempt, retrying on HTTP 429. The provided `body` is re-sent verbatim
     * per attempt, so it must be a replayable value (string/Buffer), not a
     * single-use stream.
     */
    private async dispatch(url: string, init: RequestInit): Promise<Response> {
        for (let attempt = 0; ; attempt++) {
            const headers = new Headers(init.headers);
            const cookieHeader = this.jar.header(url);
            if (cookieHeader) headers.set('Cookie', cookieHeader);

            const response = await this.fetchImpl(url, { ...init, headers });
            this.jar.ingest(getSetCookies(response.headers), url);

            if (response.status !== 429) return response;

            const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
            if (attempt >= this.retry.maxRetries) {
                const body = await response.text().catch(() => '');
                const plural = this.retry.maxRetries === 1 ? 'retry' : 'retries';
                throw new RateLimitError(
                    `iCloud rate limited the request (429) after ${this.retry.maxRetries} ${plural}`,
                    429,
                    body,
                    retryAfterMs,
                );
            }

            const backoff = retryAfterMs ?? this.retry.baseDelayMs * 2 ** attempt;
            await this.retry.sleep(Math.min(backoff, this.retry.maxDelayMs));
        }
    }
}
