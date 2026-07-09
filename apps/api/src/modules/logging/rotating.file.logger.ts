import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '@maroonedsoftware/logger';

/** Log levels ordered most-severe first; a message is written when its rank is <= the threshold's rank. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

/** Options for {@link RotatingFileLogger}. */
export interface RotatingFileLoggerOptions {
    /** Directory the log files live in. Created (recursively) if missing. */
    dir: string;
    /** Active file name within {@link dir}. Rotated copies get a `.1`…`.N` suffix. Defaults to `api.log`. */
    fileName?: string;
    /** Lowest level to persist. Defaults to `info` (drops `debug`/`trace`). */
    level?: LogLevel;
    /** Rotate once the active file passes this many bytes. Defaults to 5 MB. */
    maxSizeBytes?: number;
    /** Total files to keep, including the active one. Older files are dropped. Defaults to 5. Minimum 1. */
    maxFiles?: number;
    /** Whether file writes are on. `false` skips the file (the mirror still receives messages). Defaults to `true`. */
    enabled?: boolean;
    /** Optional logger to also forward every (level-passing) message to, e.g. a {@link ConsoleLogger}. */
    mirror?: Logger;
    /** Clock, injectable for tests. Defaults to `() => new Date()`. */
    now?: () => Date;
}

/** The runtime-tunable subset of {@link RotatingFileLoggerOptions}, applied via {@link RotatingFileLogger.configure}. */
export interface RotatingFileLoggerConfig {
    enabled?: boolean;
    level?: LogLevel;
    maxSizeBytes?: number;
    maxFiles?: number;
}

/**
 * A zero-dependency {@link Logger} that appends structured lines to a rotating
 * file on disk. Writes are **synchronous** (`appendFileSync`) so a line is
 * durably on disk before control returns — the property that lets it capture the
 * reason a process crashes, where a buffered async stream would lose the last
 * lines. When the active file passes {@link RotatingFileLoggerOptions.maxSizeBytes}
 * it is rolled to `<name>.1`, the previous `.1`→`.2`, and so on up to
 * {@link RotatingFileLoggerOptions.maxFiles}; the oldest is discarded.
 *
 * An optional {@link RotatingFileLoggerOptions.mirror} logger receives the same
 * messages, so file logging can be layered over the existing console output
 * rather than replacing it.
 */
export class RotatingFileLogger extends Logger {
    private readonly filePath: string;
    private readonly mirror?: Logger;
    private readonly dir: string;
    private readonly now: () => Date;
    // Mutable so the settings UI can retune the logger at runtime (see {@link configure}).
    private enabled: boolean;
    private level: LogLevel;
    private maxSizeBytes: number;
    private maxFiles: number;
    /** Whether the log directory is usable. `false` disables file writes so a bad path can never crash or spam. */
    private dirReady = false;
    /** Cached active-file size so most writes avoid a `statSync`; refreshed on rotate. */
    private size = 0;

    constructor(options: RotatingFileLoggerOptions) {
        super();
        this.dir = options.dir;
        this.filePath = path.join(options.dir, options.fileName ?? 'api.log');
        this.enabled = options.enabled ?? true;
        this.level = options.level ?? 'info';
        this.maxSizeBytes = Math.max(1, options.maxSizeBytes ?? 5_000_000);
        this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 5));
        this.mirror = options.mirror;
        this.now = options.now ?? (() => new Date());

        // File logging is a best-effort diagnostic: it must never be able to crash
        // the app it is meant to observe. If the directory can't be created or read
        // (e.g. an unwritable/read-only mount), disable file writes and keep going —
        // the console mirror still carries every message to `docker logs`.
        this.tryReadyDir();
    }

    /**
     * Retune the logger in place, without recreating it — so a settings change in
     * the UI takes effect on the next log line rather than at the next restart. The
     * log directory is fixed at construction (it is infra) and is not tunable here.
     * A lowered `maxFiles`/`maxSizeBytes` applies from the next rotation onward.
     */
    configure(config: RotatingFileLoggerConfig): void {
        if (config.enabled !== undefined) this.enabled = config.enabled;
        if (config.level !== undefined) this.level = config.level;
        if (config.maxSizeBytes !== undefined) this.maxSizeBytes = Math.max(1, config.maxSizeBytes);
        if (config.maxFiles !== undefined) this.maxFiles = Math.max(1, Math.floor(config.maxFiles));
        // Re-enabling from the UI after the directory was unavailable (e.g. the
        // operator fixed permissions) should retry it, so file logging recovers
        // without a restart.
        if (this.enabled && !this.dirReady) this.tryReadyDir();
    }

    /** Attempt to (re)create the log directory; on success file writes resume, on failure they stay off. */
    private tryReadyDir(): void {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            this.size = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
            this.dirReady = true;
        } catch (error) {
            this.reportUnavailable(error);
        }
    }

    error(message: unknown, ...optionalParams: unknown[]): void {
        this.write('error', message, optionalParams);
        this.mirror?.error(message, ...optionalParams);
    }

    warn(message: unknown, ...optionalParams: unknown[]): void {
        this.write('warn', message, optionalParams);
        this.mirror?.warn(message, ...optionalParams);
    }

    info(message: unknown, ...optionalParams: unknown[]): void {
        this.write('info', message, optionalParams);
        this.mirror?.info(message, ...optionalParams);
    }

    debug(message: unknown, ...optionalParams: unknown[]): void {
        this.write('debug', message, optionalParams);
        this.mirror?.debug(message, ...optionalParams);
    }

    trace(message: unknown, ...optionalParams: unknown[]): void {
        this.write('trace', message, optionalParams);
        this.mirror?.trace(message, ...optionalParams);
    }

    private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
        if (!this.enabled || !this.dirReady || RANK[level] > RANK[this.level]) return;

        const parts = [message, ...optionalParams].map(part => format(part)).filter(part => part.length > 0);
        const line = `${this.now().toISOString()} ${level.toUpperCase().padEnd(5)} ${parts.join(' ')}\n`;
        const bytes = Buffer.byteLength(line);

        // Rotate before writing when the active file is non-empty and the new line
        // would push it past the cap, so each file stays roughly <= maxSizeBytes.
        if (this.size > 0 && this.size + bytes > this.maxSizeBytes) this.rotate();

        try {
            fs.appendFileSync(this.filePath, line);
            this.size += bytes;
        } catch (error) {
            // A logger must never throw into the caller (least of all a crash
            // handler). If the very first write fails, stop trying (mark the dir
            // unusable) so we don't spam the console for every subsequent line.
            this.reportUnavailable(error);
        }
    }

    /** Turn file logging off after a filesystem failure and warn once, on the mirror (and console as a fallback). */
    private reportUnavailable(error: unknown): void {
        this.dirReady = false;
        const note = `RotatingFileLogger: file logging disabled — cannot write to log directory ${this.dir}`;
        if (this.mirror) this.mirror.warn(note, error);
        else console.warn(note, error);
    }

    /** Roll `<name>` → `<name>.1` → … dropping the oldest, or truncate when only one file is kept. */
    private rotate(): void {
        try {
            if (this.maxFiles <= 1) {
                fs.writeFileSync(this.filePath, '');
                this.size = 0;
                return;
            }
            fs.rmSync(`${this.filePath}.${this.maxFiles - 1}`, { force: true });
            for (let i = this.maxFiles - 2; i >= 1; i--) {
                const src = `${this.filePath}.${i}`;
                if (fs.existsSync(src)) fs.renameSync(src, `${this.filePath}.${i + 1}`);
            }
            if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
            this.size = 0;
        } catch (error) {
            console.error('RotatingFileLogger: failed to rotate log files', error);
        }
    }
}

/** Render a log argument to a single-line-friendly string: full stack for errors, JSON for objects. */
function format(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
    if (typeof value !== 'object') return String(value);
    try {
        return JSON.stringify(value, replacer);
    } catch {
        return String(value);
    }
}

/** JSON replacer that unwraps nested Error values (which serialise to `{}` by default). */
function replacer(_key: string, value: unknown): unknown {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    return value;
}
