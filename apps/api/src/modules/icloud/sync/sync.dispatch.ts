import { Job, JobBroker } from '@maroonedsoftware/jobbroker';
import { Duration } from 'luxon';
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
