import { ConsoleLogger, Logger } from '@maroonedsoftware/logger';
import { LogConfig } from './log.config.js';
import type { LoggingSettings } from './logging.settings.js';
import { RotatingFileLogger } from './rotating.file.logger.js';

export { LogConfig } from './log.config.js';
export type { LogConfigValues } from './log.config.js';
export { RotatingFileLogger, LOG_LEVELS } from './rotating.file.logger.js';
export type { LogLevel, RotatingFileLoggerOptions, RotatingFileLoggerConfig } from './rotating.file.logger.js';
export {
    loggingSettingsSchema,
    loggingSettingsPatchSchema,
    DEFAULT_LOGGING_SETTINGS,
} from './logging.settings.js';
export type { LoggingSettings, LoggingSettingsPatch } from './logging.settings.js';

/**
 * Push the database-backed {@link LoggingSettings} onto the live logger, if it is
 * a {@link RotatingFileLogger}. A no-op for any other {@link Logger} (e.g. a test
 * double), so callers need not know the concrete type. Converts the UI's
 * megabytes to the logger's bytes.
 */
export function applyLoggingSettings(logger: Logger, settings: LoggingSettings): void {
    if (!(logger instanceof RotatingFileLogger)) return;
    logger.configure({
        enabled: settings.enabled,
        level: settings.level,
        maxSizeBytes: Math.round(settings.maxSizeMb * 1_000_000),
        maxFiles: settings.maxFiles,
    });
}

/**
 * Build the application {@link Logger} from a {@link LogConfig}: a
 * {@link RotatingFileLogger} that persists every message to disk while mirroring
 * it to a {@link ConsoleLogger}, so terminal/`docker logs` output is unchanged
 * and there is now also a durable, rotating record to inspect after a crash.
 */
export function buildLogger(config: LogConfig, mirror: Logger = new ConsoleLogger()): RotatingFileLogger {
    return new RotatingFileLogger({
        dir: config.dir,
        level: config.level,
        maxSizeBytes: config.maxSizeBytes,
        maxFiles: config.maxFiles,
        mirror,
    });
}

/** Dependencies for {@link createFatalReporter}. */
export interface FatalReporterDeps {
    logger: Logger;
    /** Best-effort graceful shutdown to run before exiting (e.g. close the server/db). */
    onFatal?: () => unknown;
    /** Process exit, injectable for tests. Defaults to `process.exit`. */
    exit?: (code: number) => void;
}

/**
 * Build the handler that records a fatal, otherwise-unhandled error and tears the
 * process down. It logs synchronously (the {@link RotatingFileLogger} write is
 * durable before this returns), then runs {@link FatalReporterDeps.onFatal} once
 * on a best-effort basis and exits non-zero. Guarded so a second fault mid-shutdown
 * is still logged but does not restart the shutdown.
 */
export function createFatalReporter(deps: FatalReporterDeps): (label: string, error: unknown) => void {
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    let shuttingDown = false;
    return (label, error) => {
        deps.logger.error(label, error);
        if (shuttingDown) return;
        shuttingDown = true;
        void Promise.resolve()
            .then(() => deps.onFatal?.())
            .catch((shutdownError: unknown) => deps.logger.error('shutdown after fatal error failed', shutdownError))
            .finally(() => exit(1));
    };
}

/**
 * Install process-level handlers so the reasons a process dies are captured in the
 * log rather than lost to stderr: `uncaughtException` and `unhandledRejection`
 * become durable `error` entries followed by a graceful-ish shutdown, and Node
 * `warning`s (deprecations, leaked listeners, memory) are recorded at `warn`.
 * Returns a disposer that removes the listeners again.
 */
export function installGlobalErrorHandlers(logger: Logger, options: { onFatal?: () => unknown; exit?: (code: number) => void } = {}): () => void {
    const report = createFatalReporter({ logger, onFatal: options.onFatal, exit: options.exit });
    const onException = (error: unknown, origin: string): void => report(`uncaught exception (${origin})`, error);
    const onRejection = (reason: unknown): void => report('unhandled promise rejection', reason);
    const onWarning = (warning: Error): void => logger.warn('process warning', warning);

    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onRejection);
    process.on('warning', onWarning);

    return () => {
        process.off('uncaughtException', onException);
        process.off('unhandledRejection', onRejection);
        process.off('warning', onWarning);
    };
}
