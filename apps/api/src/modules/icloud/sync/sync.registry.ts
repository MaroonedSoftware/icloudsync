/**
 * In-memory map of each account to the id of the most recent photo-sync job
 * enqueued for it. It is the bridge that lets an HTTP request cancel a
 * background sync: the producer ({@link enqueueSync}) records the job id here,
 * and a `POST …/sync/cancel` route looks it up to call
 * {@link https://npmjs.com/package/@maroonedsoftware/jobbroker | JobBroker.cancel}.
 *
 * Job state itself lives in pg-boss, not here: cancellation and the "is a sync
 * running" flag are resolved by asking the broker about the tracked id
 * (`getJob`/`cancel`), so a stale entry for a job that has since finished is
 * harmless (the broker reports it terminal). This only needs to remember ids,
 * which is why nothing is persisted here. A process restart empties this map, but
 * pg-boss keeps (and resumes) any in-flight job, so the ids are re-tracked from
 * the durable queue on boot (see {@link reconcileTrackedSyncs}) — otherwise the
 * dashboard would report no sync running, and cancel would find nothing, while a
 * resumed sync is still going.
 */
export class SyncRegistry {
    /** account → id of the last job enqueued for it. */
    private readonly jobs = new Map<string, string>();

    /** Record the id of the job just enqueued for `account`, replacing any prior one. */
    track(account: string, jobId: string): void {
        this.jobs.set(account, jobId);
    }

    /** The id of the last job enqueued for `account`, or `undefined` if none is tracked. */
    jobId(account: string): string | undefined {
        return this.jobs.get(account);
    }

    /** Every account with a tracked job id (used to cancel them all). */
    accounts(): string[] {
        return [...this.jobs.keys()];
    }
}
