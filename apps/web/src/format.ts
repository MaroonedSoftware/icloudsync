// Small display helpers for the dashboard.

/** "just now" / "5 min ago" / "3 hours ago" / "2 days ago" from an ISO timestamp. */
export function relativeTime(iso: string | null): string {
    if (!iso) return 'never';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return 'never';
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 45) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    return new Date(then).toLocaleDateString();
}

/** A friendly label for the common cron shapes, falling back to the raw expression. */
export function scheduleLabel(cron: string): string {
    const c = cron.trim();
    if (c === '0 * * * *') return 'Every hour';
    if (c === '0 0 * * *') return 'Daily at midnight';
    const everyNHours = c.match(/^0 \*\/(\d+) \* \* \*$/);
    if (everyNHours) return `Every ${everyNHours[1]} hours`;
    const everyNMins = c.match(/^\*\/(\d+) \* \* \* \*$/);
    if (everyNMins) return `Every ${everyNMins[1]} minutes`;
    const dailyAt = c.match(/^0 (\d+) \* \* \*$/);
    if (dailyAt) return `Daily at ${String(dailyAt[1]).padStart(2, '0')}:00`;
    return c;
}

/** Year of an epoch-ms capture date, or undefined. */
export function year(epochMs: number | null): number | undefined {
    return epochMs == null ? undefined : new Date(epochMs).getFullYear();
}

/** Compact integer formatting, e.g. 1,234. */
export function count(n: number): string {
    return n.toLocaleString();
}

/** Human-readable byte size, e.g. "4.2 GB". */
export function bytes(n: number): string {
    if (n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const value = n / 1024 ** i;
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
