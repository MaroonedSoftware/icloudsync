import { KyselyPool } from '@maroonedsoftware/kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { createRegistry } from 'injectkit';
import { describe, expect, it, vi } from 'vitest';
import { isTransientConnectionError, logDbBackgroundError, registerData } from '../../src/modules/data/data.module.js';

function fakeLogger(): Logger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
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
        // A pooler restart is transient, so it is logged at WARN (one line), not ERROR.
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('terminating connection due to administrator command'));
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('does not throw on a background pool error when no logger is supplied', () => {
        const registry = createRegistry();
        registerData(registry, 'postgres://user:pass@localhost:5432/db');

        const pool = registry.build().get(KyselyPool);
        expect(() => pool.emit('error', new Error('boom'))).not.toThrow();
    });
});

describe('isTransientConnectionError', () => {
    it('classifies pooler-connectivity blips as transient', () => {
        expect(isTransientConnectionError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:6432'), { code: 'ECONNREFUSED' }))).toBe(true);
        expect(isTransientConnectionError(new Error('Connection terminated due to connection timeout'))).toBe(true);
        expect(isTransientConnectionError(new Error('timeout exceeded when trying to connect'))).toBe(true);
        expect(isTransientConnectionError(new Error('terminating connection due to administrator command'))).toBe(true);
        expect(isTransientConnectionError(Object.assign(new Error('admin shutdown'), { code: '57P01' }))).toBe(true);
    });

    it('does not classify a genuine query/logic error as transient', () => {
        expect(isTransientConnectionError(new Error('duplicate key value violates unique constraint'))).toBe(false);
        expect(isTransientConnectionError(Object.assign(new Error('syntax error'), { code: '42601' }))).toBe(false);
    });
});

describe('logDbBackgroundError', () => {
    it('logs transient connectivity errors at WARN and genuine errors at ERROR', () => {
        const logger = fakeLogger();

        logDbBackgroundError(logger, 'pg-boss', new Error('timeout exceeded when trying to connect'));
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();

        const genuine = new Error('relation "jobs" does not exist');
        logDbBackgroundError(logger, 'pg-boss', genuine);
        expect(logger.error).toHaveBeenCalledWith('pg-boss background error', genuine);
    });

    it('does not throw when no logger is supplied', () => {
        expect(() => logDbBackgroundError(undefined, 'postgres pool', new Error('boom'))).not.toThrow();
    });
});
