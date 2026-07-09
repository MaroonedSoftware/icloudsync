import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '@maroonedsoftware/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RotatingFileLogger } from '../../src/modules/logging/rotating.file.logger.js';
import { applyLoggingSettings } from '../../src/modules/logging/index.js';

/** A spy Logger that records every call, used to assert mirroring. */
function spyLogger(): Logger & { calls: Array<[string, unknown[]]> } {
    const calls: Array<[string, unknown[]]> = [];
    const record =
        (level: string) =>
        (message: unknown, ...params: unknown[]): void => {
            calls.push([level, [message, ...params]]);
        };
    return { calls, error: record('error'), warn: record('warn'), info: record('info'), debug: record('debug'), trace: record('trace') };
}

describe('RotatingFileLogger', () => {
    let dir: string;
    const file = (name = 'api.log'): string => path.join(dir, name);
    const read = (name = 'api.log'): string => fs.readFileSync(file(name), 'utf8');

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfl-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('creates the directory and appends a timestamped, levelled line', () => {
        const nested = path.join(dir, 'a', 'b');
        const logger = new RotatingFileLogger({ dir: nested, now: () => new Date('2026-07-09T12:00:00.000Z') });
        logger.info('hello world');

        const content = fs.readFileSync(path.join(nested, 'api.log'), 'utf8');
        expect(content).toBe('2026-07-09T12:00:00.000Z INFO  hello world\n');
    });

    it('drops messages below the configured level', () => {
        const logger = new RotatingFileLogger({ dir, level: 'warn' });
        logger.info('should be dropped');
        logger.debug('also dropped');
        logger.warn('kept');
        logger.error('kept too');

        const lines = read().trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('WARN  kept');
        expect(lines[1]).toContain('ERROR kept too');
    });

    it('serialises Error params with their stack', () => {
        const logger = new RotatingFileLogger({ dir });
        const error = new Error('boom');
        logger.error('it failed', error);

        const content = read();
        expect(content).toContain('it failed');
        expect(content).toContain('Error: boom');
        expect(content).toContain(error.stack!.split('\n')[1]!.trim());
    });

    it('serialises object params as JSON, unwrapping nested errors', () => {
        const logger = new RotatingFileLogger({ dir });
        logger.info('context', { accountId: 42, cause: new Error('nested') });

        const content = read();
        expect(content).toContain('"accountId":42');
        expect(content).toContain('"message":"nested"');
    });

    it('rotates when the active file passes the size cap, keeping maxFiles files', () => {
        const logger = new RotatingFileLogger({ dir, maxSizeBytes: 60, maxFiles: 3 });
        // Each line is well over 20 bytes, so a few writes force multiple rotations.
        for (let i = 0; i < 6; i++) logger.info(`line number ${i}`);

        expect(fs.existsSync(file('api.log'))).toBe(true);
        expect(fs.existsSync(file('api.log.1'))).toBe(true);
        expect(fs.existsSync(file('api.log.2'))).toBe(true);
        // maxFiles is 3, so a `.3` must never exist.
        expect(fs.existsSync(file('api.log.3'))).toBe(false);

        // The most recent line lives in the active file.
        expect(read('api.log')).toContain('line number 5');
    });

    it('truncates in place when only one file is kept', () => {
        const logger = new RotatingFileLogger({ dir, maxSizeBytes: 40, maxFiles: 1 });
        logger.info('first line that is fairly long');
        logger.info('second line that forces a rotate');

        expect(fs.existsSync(file('api.log.1'))).toBe(false);
        const content = read('api.log');
        expect(content).toContain('second line');
        expect(content).not.toContain('first line');
    });

    it('mirrors every written message to the mirror logger', () => {
        const mirror = spyLogger();
        const logger = new RotatingFileLogger({ dir, level: 'info', mirror });
        logger.info('to both', { k: 1 });
        logger.debug('dropped by level'); // below file threshold, but still forwarded

        expect(mirror.calls).toContainEqual(['info', ['to both', { k: 1 }]]);
        // The mirror decides its own level; the file logger forwards regardless.
        expect(mirror.calls).toContainEqual(['debug', ['dropped by level']]);
    });

    it('skips file writes when disabled but still mirrors', () => {
        const mirror = spyLogger();
        const logger = new RotatingFileLogger({ dir, enabled: false, mirror });
        logger.error('while disabled');

        expect(fs.existsSync(file('api.log'))).toBe(false);
        expect(mirror.calls).toContainEqual(['error', ['while disabled']]);
    });

    it('configure() retunes level and enabled at runtime', () => {
        const logger = new RotatingFileLogger({ dir, level: 'info' });
        logger.debug('dropped at info');
        logger.configure({ level: 'debug' });
        logger.debug('kept at debug');
        logger.configure({ enabled: false });
        logger.info('dropped while disabled');
        logger.configure({ enabled: true });
        logger.info('kept again');

        const content = read();
        expect(content).not.toContain('dropped at info');
        expect(content).toContain('kept at debug');
        expect(content).not.toContain('dropped while disabled');
        expect(content).toContain('kept again');
    });

    it('applyLoggingSettings maps DB settings (MB → bytes) onto the logger', () => {
        const logger = new RotatingFileLogger({ dir, level: 'error', maxSizeBytes: 1_000_000 });
        applyLoggingSettings(logger, { enabled: true, level: 'debug', maxSizeMb: 2, maxFiles: 3 });
        logger.debug('now visible at debug');
        expect(read()).toContain('now visible at debug');
    });

    it('applyLoggingSettings is a safe no-op for a non-file logger', () => {
        const mirror = spyLogger();
        // Should not throw for a logger that isn't a RotatingFileLogger.
        expect(() => applyLoggingSettings(mirror, { enabled: false, level: 'warn', maxSizeMb: 1, maxFiles: 1 })).not.toThrow();
    });

    it('does not throw when the log directory cannot be created; degrades to console-only', () => {
        const mirror = spyLogger();
        const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
            throw Object.assign(new Error("EACCES: permission denied, mkdir '/app/api/logs'"), { code: 'EACCES' });
        });

        // Construction must not throw (this is the crash that took the app down).
        const logger = new RotatingFileLogger({ dir: '/app/api/logs', mirror });
        expect(() => logger.error('boom while dir is unwritable')).not.toThrow();

        // The failure is reported once on the mirror, and the message still reaches it.
        expect(mirror.calls.some(([level, args]) => level === 'warn' && String(args[0]).includes('file logging disabled'))).toBe(true);
        expect(mirror.calls).toContainEqual(['error', ['boom while dir is unwritable']]);

        mkdir.mockRestore();
    });

    it('recovers file logging when re-enabled after the directory becomes usable', () => {
        const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        });
        // First construction fails to ready the dir (mocked once), so writes are off.
        const logger = new RotatingFileLogger({ dir });
        logger.info('dropped while dir unavailable');
        expect(fs.existsSync(file('api.log'))).toBe(false);

        // mkdir now works again (mock was once-only): re-enabling retries the dir.
        logger.configure({ enabled: true });
        logger.info('written after recovery');
        expect(read('api.log')).toContain('written after recovery');

        mkdir.mockRestore();
    });

    it('never throws out of a write when the append fails, and warns the mirror', () => {
        const mirror = spyLogger();
        const logger = new RotatingFileLogger({ dir, mirror });
        const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
            throw new Error('disk full');
        });

        expect(() => logger.error('boom')).not.toThrow();
        // The failure is surfaced on the mirror (the message itself still mirrors too).
        expect(mirror.calls.some(([level, args]) => level === 'warn' && String(args[0]).includes('file logging disabled'))).toBe(true);

        spy.mockRestore();
    });
});
