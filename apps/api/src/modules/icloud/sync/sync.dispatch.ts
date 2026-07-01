import { Job, JobBroker } from '@maroonedsoftware/jobbroker';
import { SYNC_PHOTOS_JOB, type SyncPhotosPayload } from './sync.photos.job.js';
import { SyncRegistry } from './sync.registry.js';

/** The pg-boss queue name for the scheduled sweep that fans out per-account syncs. */
export const SYNC_SWEEP_JOB = 'icloud/sync-sweep';

/** The account listing the sweep needs; {@link ICloudService} satisfies it structurally. */
export interface AccountLister {
    /** Every registered account to consider syncing. */
    listAccounts(): Promise<string[]>;
}

/**
 * Enqueue a photo sync for a single account and remember the job id so a later
 * `POST …/sync/cancel` can cancel it via {@link JobBroker.cancel}. The account
 * is written into the payload, overriding any `accountName` in `options`.
 * Returns the enqueued job id.
 */
export async function enqueueSync(broker: JobBroker, registry: SyncRegistry, account: string, options: SyncPhotosPayload = {}): Promise<string> {
    const jobId = await broker.send(SYNC_PHOTOS_JOB, { ...options, accountName: account });
    registry.track(account, jobId);
    return jobId;
}

/**
 * Fan a sync out across accounts: enqueue one {@link SYNC_PHOTOS_JOB} per
 * account so each run retries and cancels independently. Returns what was
 * queued (account → job id).
 */
export async function dispatchSync(
    broker: JobBroker,
    registry: SyncRegistry,
    accounts: string[],
    options: SyncPhotosPayload = {},
): Promise<Array<{ account: string; jobId: string }>> {
    return Promise.all(accounts.map(async account => ({ account, jobId: await enqueueSync(broker, registry, account, options) })));
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
        await dispatchSync(this.broker, this.registry, accounts, payload);
    }
}
