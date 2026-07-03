import { Job } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { PhotoArchive } from '../storage/photo.archive.js';
import { sidecarKey } from '../storage/photo.sidecar.js';
import type { BackedUpAsset } from './photos.repository.js';

/** The pg-boss queue name for the archive-relocation job. */
export const RELOCATE_ARCHIVE_JOB = 'icloud/relocate-archive';

/**
 * Payload for {@link RelocateArchiveJob}: move an account's archive between
 * prefixes. All fields are optional (the queue's payload type is structural); a
 * run missing any of them, or with `fromPrefix === toPrefix`, is a no-op.
 */
export interface RelocateArchivePayload {
    /** The account whose archived files should be relocated. */
    accountId?: string;
    /** The effective prefix the files currently live under. */
    fromPrefix?: string;
    /** The effective prefix to move them to. */
    toPrefix?: string;
}

/**
 * The persistence surface the relocation job needs. {@link PhotosRepository}
 * satisfies it structurally; kept minimal so the job can be unit-tested with a
 * fake.
 */
export interface ArchiveRelocationStore {
    /** Every backed-up asset for an account, keyed by record name, with its stored key. */
    backedUp(accountId: string): Promise<Map<string, BackedUpAsset>>;
    /** Point an asset's recorded archive key at its new location. */
    rekeyBackup(accountId: string, recordName: string, key: string): Promise<void>;
}

/**
 * Where the job records its outcome so the settings view can surface it.
 * {@link AccountsService} satisfies it structurally.
 */
export interface RelocationStatusStore {
    /**
     * Record the move outcome: `error` is a failure summary (or `null` after a
     * fully successful move), and `resumeFrom` is the prefix a failed move should
     * be resumed from (or `null` when nothing is left to move).
     */
    setRelocationState(accountId: string, error: string | null, resumeFrom: string | null): Promise<void>;
}

/**
 * Background job that relocates an account's already-archived files after its
 * `archive_prefix` changes: it moves each backed-up object from `fromPrefix` to
 * `toPrefix` and repoints the stored key, so a prefix change doesn't orphan the
 * existing archive. Running this off the request thread keeps the settings PATCH
 * fast even for a large library.
 *
 * Idempotent and resumable: a moved file's key no longer lives under
 * `fromPrefix` (so a retry skips it), and {@link PhotoArchive.move} treats a
 * missing source as already moved — so re-running after an interruption (or a
 * crash mid-move) finishes the job cleanly rather than double-moving or failing.
 * Cancellation is cooperative via the runner's {@link AbortSignal}, checked
 * between files.
 *
 * Per-file failures don't abort the run: each move is caught so a single bad
 * file can't strand the rest, and the outcome is recorded on the account
 * ({@link RelocationStatusStore.setRelocationError}) — a summary when any file
 * failed, or `null` when the whole move (or the part not aborted) succeeded — so
 * the settings view can surface it.
 */
export class RelocateArchiveJob extends Job<RelocateArchivePayload> {
    constructor(
        private readonly archive: PhotoArchive,
        private readonly store: ArchiveRelocationStore,
        private readonly status: RelocationStatusStore,
        private readonly logger: Logger,
    ) {
        super();
    }

    async run(payload: RelocateArchivePayload = {}, signal?: AbortSignal): Promise<void> {
        const { accountId, fromPrefix, toPrefix } = payload;
        if (!accountId || !fromPrefix || !toPrefix || fromPrefix === toPrefix) return;

        let moved = 0;
        let failed = 0;
        let firstError: string | undefined;
        let aborted = false;

        for (const [recordName, { key }] of await this.store.backedUp(accountId)) {
            if (signal?.aborted) {
                aborted = true;
                break;
            }
            if (!key) continue;
            const newKey = this.archive.reprefix(key, fromPrefix, toPrefix);
            if (!newKey) continue; // not under the old prefix (already relocated, or a custom key) — leave it
            try {
                await this.archive.move(key, newKey);
                // Carry the asset's XMP sidecar (immich preset) along with it. `move`
                // treats a missing source as already-moved, so assets without a
                // sidecar cost one cheap no-op rather than needing a lookup.
                await this.archive.move(sidecarKey(key), sidecarKey(newKey));
                await this.store.rekeyBackup(accountId, recordName, newKey);
                moved += 1;
            } catch (error) {
                failed += 1;
                if (!firstError) firstError = error instanceof Error ? error.message : String(error);
                this.logger.warn(`[${RELOCATE_ARCHIVE_JOB}] failed to move ${key} → ${newKey}: ${String(error)}`);
            }
        }

        // Don't overwrite a good status when a cancel cut the run short with no failures.
        if (!aborted || failed > 0) {
            // On any failure, remember the source prefix so a one-click retry can resume the move.
            const summary = failed > 0 ? `Moved ${moved} file(s); ${failed} failed to move: ${firstError}` : null;
            await this.status.setRelocationState(accountId, summary, failed > 0 ? fromPrefix : null);
        }
        this.logger.info(`[${RELOCATE_ARCHIVE_JOB}] relocated ${moved} file(s) (${failed} failed) for ${accountId}: ${fromPrefix} → ${toPrefix}`);
    }
}
