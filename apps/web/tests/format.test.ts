import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytes, count, relativeTime, scheduleLabel, year } from '../src/format';

describe('relativeTime', () => {
    // Pin "now" so the relative buckets are deterministic.
    const now = new Date('2026-07-01T12:00:00.000Z');

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const SEC = 1000;
    const MIN = 60 * SEC;
    const HOUR = 60 * MIN;
    const DAY = 24 * HOUR;

    it('returns "never" for null or unparseable input', () => {
        expect(relativeTime(null)).toBe('never');
        expect(relativeTime('not-a-date')).toBe('never');
    });

    it('clamps future timestamps to "just now"', () => {
        expect(relativeTime(new Date(now.getTime() + 10 * SEC).toISOString())).toBe('just now');
    });

    it('reports sub-45-second gaps as "just now"', () => {
        expect(relativeTime(ago(0))).toBe('just now');
        expect(relativeTime(ago(44 * SEC))).toBe('just now');
    });

    it('reports minutes', () => {
        expect(relativeTime(ago(60 * SEC))).toBe('1 min ago');
        expect(relativeTime(ago(5 * MIN))).toBe('5 min ago');
        expect(relativeTime(ago(59 * MIN))).toBe('59 min ago');
    });

    it('reports hours with singular/plural agreement', () => {
        expect(relativeTime(ago(HOUR))).toBe('1 hour ago');
        expect(relativeTime(ago(3 * HOUR))).toBe('3 hours ago');
    });

    it('reports days with singular/plural agreement', () => {
        expect(relativeTime(ago(DAY))).toBe('1 day ago');
        expect(relativeTime(ago(2 * DAY))).toBe('2 days ago');
        expect(relativeTime(ago(29 * DAY))).toBe('29 days ago');
    });

    it('falls back to a locale date string past 30 days', () => {
        const iso = ago(40 * DAY);
        expect(relativeTime(iso)).toBe(new Date(iso).toLocaleDateString());
    });
});

describe('scheduleLabel', () => {
    it('names the well-known cron shapes', () => {
        expect(scheduleLabel('0 * * * *')).toBe('Every hour');
        expect(scheduleLabel('0 0 * * *')).toBe('Daily at midnight');
        expect(scheduleLabel('0 */6 * * *')).toBe('Every 6 hours');
        expect(scheduleLabel('*/15 * * * *')).toBe('Every 15 minutes');
        expect(scheduleLabel('0 9 * * *')).toBe('Daily at 09:00');
        expect(scheduleLabel('0 14 * * *')).toBe('Daily at 14:00');
    });

    it('trims surrounding whitespace before matching', () => {
        expect(scheduleLabel('  0 * * * *  ')).toBe('Every hour');
    });

    it('falls back to the raw expression when nothing matches', () => {
        expect(scheduleLabel('5 4 * * 1')).toBe('5 4 * * 1');
    });
});

describe('year', () => {
    it('returns undefined for null', () => {
        expect(year(null)).toBeUndefined();
    });

    it('extracts the calendar year from epoch milliseconds', () => {
        // Mid-year and midday UTC so no timezone can shift the year.
        expect(year(Date.UTC(2021, 5, 15, 12))).toBe(2021);
    });
});

describe('count', () => {
    it('renders small numbers verbatim', () => {
        expect(count(0)).toBe('0');
        expect(count(42)).toBe('42');
    });

    it('groups large numbers (locale-independent digit check)', () => {
        // Assert the digits survive regardless of the grouping separator.
        expect(count(1234567).replace(/\D/g, '')).toBe('1234567');
        expect(count(1000)).not.toBe('1000');
    });
});

describe('bytes', () => {
    it('treats zero and negatives as "0 B"', () => {
        expect(bytes(0)).toBe('0 B');
        expect(bytes(-500)).toBe('0 B');
    });

    it('formats bytes without decimals', () => {
        expect(bytes(1)).toBe('1 B');
        expect(bytes(512)).toBe('512 B');
        expect(bytes(1023)).toBe('1023 B');
    });

    it('formats larger units with one decimal place', () => {
        expect(bytes(1024)).toBe('1.0 KB');
        expect(bytes(1536)).toBe('1.5 KB');
        expect(bytes(5 * 1024 * 1024)).toBe('5.0 MB');
        expect(bytes(1024 ** 3)).toBe('1.0 GB');
        expect(bytes(2.5 * 1024 ** 4)).toBe('2.5 TB');
    });

    it('caps at the largest known unit', () => {
        expect(bytes(3 * 1024 ** 5)).toBe('3072.0 TB');
    });
});
