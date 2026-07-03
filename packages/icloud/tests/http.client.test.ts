import { describe, expect, it } from 'vitest';
import { RateLimitError } from '../src/errors.js';
import { HttpClient, parseRetryAfter } from '../src/http/client.js';
import type { FetchLike } from '../src/http/client.js';

/** A fetch double that replays a scripted queue of responses and records waits. */
function scripted(responses: Response[]): { fetchImpl: FetchLike; calls: number } {
    const state = { fetchImpl: null as unknown as FetchLike, calls: 0 };
    state.fetchImpl = async () => {
        const res = responses[state.calls];
        state.calls += 1;
        if (!res) throw new Error('fetch called more times than scripted');
        return res;
    };
    return state as { fetchImpl: FetchLike; calls: number };
}

const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const tooMany = (headers: Record<string, string> = {}): Response => new Response('slow down', { status: 429, headers });

describe('parseRetryAfter', () => {
    it('reads delta-seconds', () => {
        expect(parseRetryAfter('5')).toBe(5_000);
        expect(parseRetryAfter('0')).toBe(0);
    });

    it('reads an HTTP-date relative to now', () => {
        const now = 1_000_000;
        expect(parseRetryAfter(new Date(now + 3_000).toUTCString(), now)).toBe(3_000);
    });

    it('never returns a negative wait for a past date', () => {
        const now = 1_000_000;
        expect(parseRetryAfter(new Date(now - 5_000).toUTCString(), now)).toBe(0);
    });

    it('returns undefined for a missing or unparseable header', () => {
        expect(parseRetryAfter(null)).toBeUndefined();
        expect(parseRetryAfter('nonsense')).toBeUndefined();
    });
});

describe('HttpClient 429 handling', () => {
    it('retries after a 429 and returns the eventual success', async () => {
        const script = scripted([tooMany(), tooMany(), json(200, { ok: true })]);
        const waits: number[] = [];
        const client = new HttpClient(undefined, script.fetchImpl, { sleep: async ms => void waits.push(ms) });

        const res = await client.send<{ ok: boolean }>('https://icloud.com/x');

        expect(res.status).toBe(200);
        expect(res.data).toEqual({ ok: true });
        expect(script.calls).toBe(3);
        // Exponential backoff with baseDelayMs 1000: 1000 then 2000.
        expect(waits).toEqual([1_000, 2_000]);
    });

    it('honors the Retry-After header over exponential backoff', async () => {
        const script = scripted([tooMany({ 'Retry-After': '7' }), json(200)]);
        const waits: number[] = [];
        const client = new HttpClient(undefined, script.fetchImpl, { sleep: async ms => void waits.push(ms) });

        await client.send('https://icloud.com/x');

        expect(waits).toEqual([7_000]);
    });

    it('caps the wait at maxDelayMs', async () => {
        const script = scripted([tooMany({ 'Retry-After': '3600' }), json(200)]);
        const waits: number[] = [];
        const client = new HttpClient(undefined, script.fetchImpl, { maxDelayMs: 30_000, sleep: async ms => void waits.push(ms) });

        await client.send('https://icloud.com/x');

        expect(waits).toEqual([30_000]);
    });

    it('throws RateLimitError once retries are exhausted', async () => {
        const script = scripted([tooMany({ 'Retry-After': '4' }), tooMany({ 'Retry-After': '4' })]);
        const client = new HttpClient(undefined, script.fetchImpl, { maxRetries: 1, sleep: async () => {} });

        const err = await client.send('https://icloud.com/x').catch(e => e);

        expect(err).toBeInstanceOf(RateLimitError);
        expect(err.status).toBe(429);
        expect(err.retryAfterMs).toBe(4_000);
        expect(err.body).toBe('slow down');
        expect(script.calls).toBe(2); // initial + 1 retry
    });

    it('fails fast with maxRetries 0', async () => {
        const script = scripted([tooMany()]);
        const client = new HttpClient(undefined, script.fetchImpl, { maxRetries: 0, sleep: async () => {} });

        await expect(client.send('https://icloud.com/x')).rejects.toBeInstanceOf(RateLimitError);
        expect(script.calls).toBe(1);
    });

    it('applies the same retry policy to raw() downloads', async () => {
        const script = scripted([tooMany(), new Response('binary', { status: 200 })]);
        const waits: number[] = [];
        const client = new HttpClient(undefined, script.fetchImpl, { sleep: async ms => void waits.push(ms) });

        const res = await client.raw('https://cvws.icloud.com/asset');

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('binary');
        expect(waits).toEqual([1_000]);
    });
});
