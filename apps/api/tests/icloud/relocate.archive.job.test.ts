import type { Logger } from '@maroonedsoftware/logger';
import { describe, expect, it } from 'vitest';
import type { PhotoArchive } from '../../src/modules/icloud/storage/photo.archive.js';
import { RelocateArchiveJob, type ArchiveRelocationStore, type RelocationStatusStore } from '../../src/modules/icloud/sync/relocate.archive.job.js';
import type { BackedUpAsset } from '../../src/modules/icloud/sync/photos.repository.js';

const silentLogger: Logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

/** Records moves; re-roots keys the way the real archive does (empty base prefix). Optionally fails for given keys. */
class FakeArchive {
    readonly moves: Array<{ from: string; to: string }> = [];
    readonly failOn = new Set<string>();
    /** Sidecar keys that actually exist; an absent `.xmp` source is a no-op, as in the real archive. */
    readonly sidecars = new Set<string>();
    reprefix = (key: string, from: string, to: string): string | null => (key.startsWith(`${from}/`) ? `${to}/${key.slice(from.length + 1)}` : null);
    move = (from: string, to: string): Promise<void> => {
        if (this.failOn.has(from)) return Promise.reject(new Error(`storage down: ${from}`));
        // The job also tries to move each asset's `<key>.xmp` sidecar; a missing one is a silent no-op.
        if (from.endsWith('.xmp') && !this.sidecars.has(from)) return Promise.resolve();
        this.moves.push({ from, to });
        return Promise.resolve();
    };
}

/** Serves a seedable set of backed-up assets and records key updates. */
class FakeStore implements ArchiveRelocationStore {
    readonly backed = new Map<string, BackedUpAsset>();
    readonly rekeys: Array<{ recordName: string; key: string }> = [];
    backedUp = () => Promise.resolve(new Map(this.backed));
    rekeyBackup = (_id: string, recordName: string, key: string): Promise<void> => {
        this.rekeys.push({ recordName, key });
        return Promise.resolve();
    };
}

/** Records the per-account relocation outcomes the job writes. */
class FakeStatus implements RelocationStatusStore {
    readonly states: Array<{ error: string | null; resumeFrom: string | null }> = [];
    setRelocationState = (_id: string, error: string | null, resumeFrom: string | null): Promise<void> => {
        this.states.push({ error, resumeFrom });
        return Promise.resolve();
    };
}

const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';

function make() {
    const archive = new FakeArchive();
    const store = new FakeStore();
    const status = new FakeStatus();
    const job = new RelocateArchiveJob(archive as unknown as PhotoArchive, store, status, silentLogger);
    return { job, archive, store, status };
}

describe('RelocateArchiveJob', () => {
    it('moves each backed-up file under the old prefix, repoints its key, and clears the error', async () => {
        const { job, archive, store, status } = make();
        store.backed.set('A', { checksum: 'a', key: `${ACCOUNT_ID}/2024/A.jpg` });
        store.backed.set('B', { checksum: 'b', key: `${ACCOUNT_ID}/B.jpg` });

        await job.run({ accountId: ACCOUNT_ID, fromPrefix: ACCOUNT_ID, toPrefix: 'family' });

        expect(archive.moves).toEqual([
            { from: `${ACCOUNT_ID}/2024/A.jpg`, to: 'family/2024/A.jpg' },
            { from: `${ACCOUNT_ID}/B.jpg`, to: 'family/B.jpg' },
        ]);
        expect(store.rekeys).toEqual([
            { recordName: 'A', key: 'family/2024/A.jpg' },
            { recordName: 'B', key: 'family/B.jpg' },
        ]);
        expect(status.states).toEqual([{ error: null, resumeFrom: null }]); // success clears the error and the resume marker
    });

    it("carries an asset's XMP sidecar along to the new prefix", async () => {
        const { job, archive, store } = make();
        store.backed.set('A', { checksum: 'a', key: `${ACCOUNT_ID}/A.jpg` });
        archive.sidecars.add(`${ACCOUNT_ID}/A.jpg.xmp`); // A has a sidecar; it should move with it

        await job.run({ accountId: ACCOUNT_ID, fromPrefix: ACCOUNT_ID, toPrefix: 'family' });

        expect(archive.moves).toEqual([
            { from: `${ACCOUNT_ID}/A.jpg`, to: 'family/A.jpg' },
            { from: `${ACCOUNT_ID}/A.jpg.xmp`, to: 'family/A.jpg.xmp' },
        ]);
    });

    it('leaves files that are not under the old prefix (already relocated or custom key)', async () => {
        const { job, archive, store, status } = make();
        store.backed.set('A', { checksum: 'a', key: 'family/A.jpg' }); // already under the new prefix
        store.backed.set('N', { checksum: 'n', key: null }); // never backed up to a key

        await job.run({ accountId: ACCOUNT_ID, fromPrefix: ACCOUNT_ID, toPrefix: 'family' });

        expect(archive.moves).toEqual([]);
        expect(store.rekeys).toEqual([]);
        expect(status.states).toEqual([{ error: null, resumeFrom: null }]);
    });

    it('keeps going past a failed file and records a failure summary', async () => {
        const { job, archive, store, status } = make();
        store.backed.set('A', { checksum: 'a', key: `${ACCOUNT_ID}/A.jpg` });
        store.backed.set('B', { checksum: 'b', key: `${ACCOUNT_ID}/B.jpg` });
        archive.failOn.add(`${ACCOUNT_ID}/A.jpg`); // A can't be moved

        await job.run({ accountId: ACCOUNT_ID, fromPrefix: ACCOUNT_ID, toPrefix: 'family' });

        // B is still moved and repointed even though A failed.
        expect(archive.moves).toEqual([{ from: `${ACCOUNT_ID}/B.jpg`, to: 'family/B.jpg' }]);
        expect(store.rekeys).toEqual([{ recordName: 'B', key: 'family/B.jpg' }]);
        expect(status.states).toHaveLength(1);
        expect(status.states[0]!.error).toContain('1 failed to move');
        expect(status.states[0]!.error).toContain('storage down');
        expect(status.states[0]!.resumeFrom).toBe(ACCOUNT_ID); // remembered so a retry can resume
    });

    it('is a no-op (and does not touch status) when the prefix is unchanged', async () => {
        const { job, archive, status } = make();
        await job.run({ accountId: ACCOUNT_ID, fromPrefix: ACCOUNT_ID, toPrefix: ACCOUNT_ID });
        expect(archive.moves).toEqual([]);
        expect(status.states).toEqual([]);
    });

    it('stops relocating once its signal is aborted, leaving status untouched', async () => {
        const { job, archive, store, status } = make();
        store.backed.set('A', { checksum: 'a', key: `${ACCOUNT_ID}/A.jpg` });
        store.backed.set('B', { checksum: 'b', key: `${ACCOUNT_ID}/B.jpg` });
        const controller = new AbortController();
        controller.abort();

        await job.run({ accountId: ACCOUNT_ID, fromPrefix: ACCOUNT_ID, toPrefix: 'family' }, controller.signal);

        expect(archive.moves).toEqual([]);
        expect(status.states).toEqual([]); // a clean cancel doesn't clobber a prior good status
    });

    it('does nothing when the payload names no account', async () => {
        const { job, archive, status } = make();
        await job.run({ accountId: '', fromPrefix: 'x', toPrefix: 'y' });
        expect(archive.moves).toEqual([]);
        expect(status.states).toEqual([]);
    });
});
