import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LogConfig } from '../../src/modules/logging/log.config.js';

describe('LogConfig', () => {
    it('applies defaults for an empty section', () => {
        const config = new LogConfig({});
        expect(config.dir).toBe(path.resolve(process.cwd(), 'logs'));
        expect(config.level).toBe('info');
        expect(config.maxSizeBytes).toBe(5_000_000);
        expect(config.maxFiles).toBe(5);
    });

    it('treats empty-string env placeholders as unset', () => {
        const config = new LogConfig({ dir: '', level: '', maxSizeMb: '', maxFiles: '' });
        expect(config.dir).toBe(path.resolve(process.cwd(), 'logs'));
        expect(config.level).toBe('info');
        expect(config.maxSizeBytes).toBe(5_000_000);
    });

    it('coerces string values and converts MB to bytes', () => {
        const config = new LogConfig({ dir: '/var/log/app', level: 'debug', maxSizeMb: '10', maxFiles: '3' });
        expect(config.dir).toBe('/var/log/app');
        expect(config.level).toBe('debug');
        expect(config.maxSizeBytes).toBe(10_000_000);
        expect(config.maxFiles).toBe(3);
    });

    it('rejects an unknown level and a non-positive size', () => {
        expect(() => new LogConfig({ level: 'verbose' })).toThrow();
        expect(() => new LogConfig({ maxSizeMb: 0 })).toThrow();
        expect(() => new LogConfig({ maxFiles: 0 })).toThrow();
    });
});
