import type { Server } from 'node:http';

/**
 * Fully shut a test HTTP server down and wait for it.
 *
 * `server.close()` returns the server (not a promise) and only completes once
 * every connection is gone, but `fetch` (undici) keeps its sockets alive, so a
 * bare `afterEach(() => server.close())` neither waits nor actually closes.
 * Under Vitest's `isolate: false` + fork parallelism, those half-open servers
 * and sockets accumulate in the shared worker and can eventually hang a later
 * `fetch` at the test timeout. Force-closing the connections first makes teardown
 * deterministic.
 */
export async function closeServer(server: Server): Promise<void> {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
    });
}
