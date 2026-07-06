import { Job, JobBroker } from '@maroonedsoftware/jobbroker';
import { Duration } from 'luxon';
import { IN_FLIGHT_STATES } from './job.status.js';
import { SYNC_PHOTOS_JOB, type SyncPhotosPayload } from './sync.photos.job.js';
import { SyncRegistry } from './sync.registry.js';

/** The pg-boss queue name for the scheduled sweep that fans out per-account syncs. */
export const SYNC_SWEEP_JOB = 'icloud/sync-sweep';

/**
 * Seconds to stagger successive accounts in a fan-out ({@link dispatchSync}).
 * Enqueuing every account's sync for immediate processing makes them all hit
 * iCloud at once — restoring sessions and paging CloudKit in lockstep — which is
 * what provokes the rate limiting the sync job then has to back off from. A
 * small `startAfter` on each subsequent account spreads that initial load out.
 */
const FANOUT_STAGGER_SECONDS = 15;

/** The account listing the sweep needs; {@link ICloudService} satisfies it structurally. */
export interface AccountLister {
    /** Every registered account (id + Apple ID) to consider syncing. */
    listAccounts(): Promise<Array<{ id: string; account: string }>>;
}

/**
 * Enqueue a photo sync for a single account (by id) and remember the job id so a
 * later `POST …/sync/cancel` can cancel it via {@link JobBroker.cancel}. The
 * account id is written into the payload, overriding any `accountId` in
 * `options`. Pass `startAfter` to defer the run (used to stagger a fan-out).
 * Returns the enqueued job id.
 */
export async function enqueueSync(
    broker: JobBroker,
    registry: SyncRegistry,
    accountId: string,
    options: SyncPhotosPayload = {},
    startAfter?: Duration,
): Promise<string> {
    const jobId = await broker.send(SYNC_PHOTOS_JOB, { ...options, accountId }, startAfter ? { startAfter } : undefined);
    registry.track(accountId, jobId);
    return jobId;
}

/**
 * A queued-or-running sync job as {@link reconcileTrackedSyncs} reads it: the
 * `id`, its lifecycle `state`, when it was enqueued, and enough of the payload to
 * recover the account it belongs to. A structural subset of pg-boss's
 * `JobWithMetadata`, so `pgboss.findJobs(SYNC_PHOTOS_JOB)` rows satisfy it directly.
 */
export interface InFlightSyncJob {
    id: string;
    /** pg-boss lifecycle state (`created`/`active`/`retry`/`completed`/…). */
    state: string;
    /** When the job was enqueued; used to keep the newest job when an account has several. */
    createdOn?: Date | string | null;
    /** The enqueued payload; its `accountId` is what the job is re-tracked under. */
    data?: { accountId?: string } | null;
}

/** Milliseconds since epoch for a job's `createdOn`, or 0 when it is missing/unparseable (sorts oldest). */
function createdAt(value: Date | string | null | undefined): number {
    if (!value) return 0;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Repopulate the in-memory {@link SyncRegistry} from the durable queue after a
 * restart. pg-boss keeps each per-account sync job (and resumes it), but the
 * registry the API reads to answer "is a sync running" and to cancel it is
 * in-memory, so a restart forgets every in-flight run — the dashboard then
 * reports `running: false` and cancel finds nothing even while a sync is still
 * going. Given the queue's jobs (e.g. from `pgboss.findJobs`), re-track the most
 * recently enqueued still-queued-or-running one per account; terminal jobs
 * (`completed`/`failed`/`cancelled`) and jobs with no account are ignored.
 * Returns the number of accounts re-tracked.
 */
export function reconcileTrackedSyncs(registry: SyncRegistry, jobs: InFlightSyncJob[]): number {
    // Newest first, so the first in-flight job seen for an account is the one kept
    // (an account can briefly have several, e.g. a sweep enqueued over a running one).
    const newestFirst = [...jobs].sort((a, b) => createdAt(b.createdOn) - createdAt(a.createdOn));
    const tracked = new Set<string>();
    for (const job of newestFirst) {
        if (!IN_FLIGHT_STATES.has(job.state)) continue;
        const accountId = job.data?.accountId;
        if (!accountId || tracked.has(accountId)) continue;
        registry.track(accountId, job.id);
        tracked.add(accountId);
    }
    return tracked.size;
}

/**
 * Fan a sync out across accounts: enqueue one {@link SYNC_PHOTOS_JOB} per
 * account id so each run retries and cancels independently. Successive accounts
 * are staggered by {@link FANOUT_STAGGER_SECONDS} (via `startAfter`) so they
 * don't all hit iCloud simultaneously. Returns what was queued (account id → job
 * id) in the same order.
 */
export async function dispatchSync(
    broker: JobBroker,
    registry: SyncRegistry,
    accountIds: string[],
    options: SyncPhotosPayload = {},
): Promise<Array<{ id: string; jobId: string }>> {
    return Promise.all(
        accountIds.map(async (id, index) => {
            const startAfter = index === 0 ? undefined : Duration.fromObject({ seconds: index * FANOUT_STAGGER_SECONDS });
            return { id, jobId: await enqueueSync(broker, registry, id, options, startAfter) };
        }),
    );
}

/**
 * Scheduled job that fans the periodic backup out into one
 * {@link SYNC_PHOTOS_JOB} per registered account, so each account's run retries
 * and cancels independently instead of sharing one long job. Runs on the
 * `sync_cron` schedule; on-demand syncs go through {@link enqueueSync} /
 * {@link dispatchSync} directly.
 */
export class SweepPhotosJob extends Job<SyncPhotosPayload> {
    constructor(
        private readonly icloud: AccountLister,
        private readonly broker: JobBroker,
        private readonly registry: SyncRegistry,
    ) {
        super();
    }

    async run(payload: SyncPhotosPayload = {}): Promise<void> {
        const accounts = await this.icloud.listAccounts();
        await dispatchSync(this.broker, this.registry, accounts.map(a => a.id), payload);
    }
}
