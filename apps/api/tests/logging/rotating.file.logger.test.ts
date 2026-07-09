import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '@maroonedsoftware/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RotatingFileLogger } from '../../src/modules/logging/rotating.file.logger.js';

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

    it('never throws out of a write when the append fails', () => {
        const logger = new RotatingFileLogger({ dir });
        const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
            throw new Error('disk full');
        });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(() => logger.error('boom')).not.toThrow();
        expect(errorSpy).toHaveBeenCalled();

        spy.mockRestore();
        errorSpy.mockRestore();
    });
});
