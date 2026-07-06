import { ImmichClient, ImmichError, type FetchLike } from './immich.client.js';

/** The minimal connection fields a probe needs (a subset of {@link ImmichSettings}). */
export interface ImmichConnection {
    baseUrl: string;
    apiKey: string;
}

/** Outcome of a connection test: `ok`, plus a user-facing reason when it failed. */
export interface ImmichCheckResult {
    ok: boolean;
    /** A human-readable failure reason when `ok` is false. */
    message?: string;
}

/**
 * Verifies an Immich connection (server reachable + API key accepted) without
 * uploading anything. Backs the settings UI's "Test connection" button and its
 * status indicator. Wraps {@link ImmichClient.verify} and turns thrown errors
 * into a plain result, so the route just relays `ok`/`message`. The `fetch` is
 * injectable so it can be exercised without a network in tests.
 */
export class ImmichProbe {
    constructor(private readonly fetchImpl: FetchLike = fetch) {}

    /** Test a connection; never throws — a failure comes back as `{ ok: false, message }`. */
    async check(connection: ImmichConnection): Promise<ImmichCheckResult> {
        const client = new ImmichClient(connection.baseUrl, connection.apiKey, 'icloudsync', this.fetchImpl);
        try {
            await client.verify();
            return { ok: true };
        } catch (error) {
            if (error instanceof ImmichError) return { ok: false, message: error.message };
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    }
}
