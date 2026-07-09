import type { Logger } from '@maroonedsoftware/logger';
import { describe, expect, it, vi } from 'vitest';
import { createFatalReporter } from '../../src/modules/logging/index.js';

function fakeLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
    return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() } as never;
}

describe('createFatalReporter', () => {
    it('logs the reason, runs graceful shutdown, then exits non-zero', async () => {
        const logger = fakeLogger();
        const exit = vi.fn();
        const onFatal = vi.fn().mockResolvedValue(undefined);
        const report = createFatalReporter({ logger, onFatal, exit });

        const error = new Error('kaboom');
        report('uncaught exception (uncaughtException)', error);

        // Logged synchronously (durable) before any async shutdown.
        expect(logger.error).toHaveBeenCalledWith('uncaught exception (uncaughtException)', error);

        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
        expect(onFatal).toHaveBeenCalledTimes(1);
    });

    it('still exits when graceful shutdown itself fails', async () => {
        const logger = fakeLogger();
        const exit = vi.fn();
        const onFatal = vi.fn().mockRejectedValue(new Error('stop failed'));
        const report = createFatalReporter({ logger, onFatal, exit });

        report('unhandled promise rejection', 'some reason');

        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
        expect(logger.error).toHaveBeenCalledWith('shutdown after fatal error failed', expect.any(Error));
    });

    it('logs a second fault but does not restart shutdown', async () => {
        const logger = fakeLogger();
        const exit = vi.fn();
        const onFatal = vi.fn().mockResolvedValue(undefined);
        const report = createFatalReporter({ logger, onFatal, exit });

        report('first', new Error('one'));
        report('second', new Error('two'));

        await vi.waitFor(() => expect(exit).toHaveBeenCalled());
        expect(logger.error).toHaveBeenCalledWith('first', expect.any(Error));
        expect(logger.error).toHaveBeenCalledWith('second', expect.any(Error));
        // Shutdown ran exactly once despite two faults.
        expect(onFatal).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledTimes(1);
    });
});
