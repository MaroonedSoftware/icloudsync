/**
 * In-memory map of each account to the size of its iCloud library, as counted at
 * the start of its most recent sync. The sync job pulls this total up front — a
 * single lightweight CloudKit count query, run before it begins paging — and
 * records it here so the dashboard can show honest progress ("X of <library
 * size>") instead of a denominator that climbs as metadata is paged in.
 *
 * Nothing is persisted: the total only matters while a sync is in flight, and a
 * process restart re-runs the (idempotent) job, which re-pulls it. When an
 * account has no recorded total the stats endpoint reports `null` and the UI
 * falls back to the count of rows already synced.
 */
export class SyncProgressRegistry {
    /** account → library asset count captured at the last sync's start. */
    private readonly libraryTotals = new Map<string, number>();

    /** Record the library asset count captured at the start of `account`'s sync. */
    setLibraryTotal(account: string, total: number): void {
        this.libraryTotals.set(account, total);
    }

    /** The library asset count captured for `account`, or `undefined` if none was recorded. */
    libraryTotal(account: string): number | undefined {
        return this.libraryTotals.get(account);
    }

    /** Forget an account's recorded total (e.g. when the account is removed). */
    clear(account: string): void {
        this.libraryTotals.delete(account);
    }
}
