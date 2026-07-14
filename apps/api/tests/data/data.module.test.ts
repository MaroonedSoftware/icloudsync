import { KyselyPool } from '@maroonedsoftware/kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { createRegistry } from 'injectkit';
import { describe, expect, it, vi } from 'vitest';
import { registerData } from '../../src/modules/data/data.module.js';

function fakeLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
    return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() } as never;
}

describe('registerData', () => {
    it("attaches a pool 'error' listener so an idle-client error is logged, not thrown", () => {
        const logger = fakeLogger();
        const registry = createRegistry();
        registerData(registry, 'postgres://user:pass@localhost:5432/db', logger);

        const pool = registry.build().get(KyselyPool);
        const error = new Error('terminating connection due to administrator command');

        // Without a listener, pg's Pool re-throws this as an uncaughtException that
        // the global handler turns into a process exit. The listener must swallow it.
        expect(() => pool.emit('error', error)).not.toThrow();
        expect(logger.error).toHaveBeenCalledWith('postgres pool background error', error);
    });

    it('does not throw on a background pool error when no logger is supplied', () => {
        const registry = createRegistry();
        registerData(registry, 'postgres://user:pass@localhost:5432/db');

        const pool = registry.build().get(KyselyPool);
        expect(() => pool.emit('error', new Error('boom'))).not.toThrow();
    });
});
