import type { Logger } from '@maroonedsoftware/logger';
import type { PhotosService } from '@icloudsync/icloud';
import { describe, expect, it } from 'vitest';
import type { PhotoArchive } from '../../src/modules/icloud/storage/photo.archive.js';
import { SyncPhotosJob, type PhotoSyncSource, type ReauthReporter } from '../../src/modules/icloud/sync/sync.photos.job.js';
import type { PhotoStore } from '../../src/modules/icloud/sync/photos.repository.js';
import type { SettingsService } from '../../src/modules/settings/settings.service.js';

const silentLogger: Logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const settings = { photosLayout: async () => 'flat' } as unknown as SettingsService;
const store = {
    upsertBatch: async () => 0,
    backedUpChecksums: async () => new Map(),
    markBackedUp: async () => {},
} as unknown as PhotoStore;
const archive = {} as PhotoArchive;

/** An empty photo library (yields no assets), enough to exercise the authenticated path. */
const emptyPhotos = (): PhotosService => ({ list: async function* () {}, getAlbums: async () => [] }) as unknown as PhotosService;

function source(authenticated: boolean): PhotoSyncSource {
    return {
        listAccounts: async () => ['me@icloud.com'],
        isAuthenticated: () => authenticated,
        restoreAccount: async () => authenticated,
        photos: () => emptyPhotos(),
        download: async () => new Uint8Array(),
    };
}

class SpyReauth implements ReauthReporter {
    notified: string[] = [];
    cleared: string[] = [];
    notifyReauthRequired = async (account: string) => {
        this.notified.push(account);
    };
    clearReauth = async (account: string) => {
        this.cleared.push(account);
    };
}

describe('SyncPhotosJob reauth notifications', () => {
    it('notifies the admin when an account cannot be restored', async () => {
        const reauth = new SpyReauth();
        const job = new SyncPhotosJob(source(false), store, archive, silentLogger, settings, reauth);

        await job.run({ metadataOnly: true, accountName: 'me@icloud.com' });

        expect(reauth.notified).toEqual(['me@icloud.com']);
        expect(reauth.cleared).toEqual([]);
    });

    it('clears the throttle when an account is authenticated', async () => {
        const reauth = new SpyReauth();
        const job = new SyncPhotosJob(source(true), store, archive, silentLogger, settings, reauth);

        await job.run({ metadataOnly: true, accountName: 'me@icloud.com' });

        expect(reauth.notified).toEqual([]);
        expect(reauth.cleared).toEqual(['me@icloud.com']);
    });
});
