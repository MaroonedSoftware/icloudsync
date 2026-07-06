import type { Logger } from '@maroonedsoftware/logger';
import type { PhotosService } from '@icloudsync/icloud';
import { describe, expect, it } from 'vitest';
import type { PhotoArchive } from '../../src/modules/icloud/storage/photo.archive.js';
import { SyncPhotosJob, type PhotoSyncSource, type ReauthReporter } from '../../src/modules/icloud/sync/sync.photos.job.js';
import type { PhotoStore } from '../../src/modules/icloud/sync/photos.repository.js';
import type { SettingsService } from '../../src/modules/settings/settings.service.js';

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const APPLE_ID = 'me@icloud.com';

const silentLogger: Logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const settings = { immich: async () => null } as unknown as SettingsService;
const store = {
    upsertBatch: async () => 0,
    backedUp: async () => new Map(),
    markBackedUp: async () => {},
} as unknown as PhotoStore;
const archive = {} as PhotoArchive;

/** Resolves the Apple ID + prefix for the account under test. */
const accounts = {
    getById: async (id: string) => ({ id, accountName: APPLE_ID, archivePrefix: null }),
    photoSettings: async () => ({ destination: null, preset: null, layout: null, naming: null }),
};

/** An empty photo library (yields no assets), enough to exercise the authenticated path. */
const emptyPhotos = (): PhotosService => ({ list: async function* () {}, getAlbums: async () => [] }) as unknown as PhotosService;

function source(authenticated: boolean): PhotoSyncSource {
    return {
        isAuthenticated: () => authenticated,
        restoreAccount: async () => authenticated,
        photos: async () => emptyPhotos(),
        download: async () => new Uint8Array(),
    };
}

class SpyReauth implements ReauthReporter {
    notified: Array<{ id: string; appleId: string }> = [];
    cleared: string[] = [];
    notifyReauthRequired = async (accountId: string, appleId: string) => {
        this.notified.push({ id: accountId, appleId });
    };
    clearReauth = async (accountId: string) => {
        this.cleared.push(accountId);
    };
}

describe('SyncPhotosJob reauth notifications', () => {
    it('notifies the admin (with the Apple ID) when an account cannot be restored', async () => {
        const reauth = new SpyReauth();
        const job = new SyncPhotosJob(source(false), store, archive, silentLogger, settings, reauth, accounts);

        await job.run({ metadataOnly: true, accountId: ACCOUNT_ID });

        expect(reauth.notified).toEqual([{ id: ACCOUNT_ID, appleId: APPLE_ID }]);
        expect(reauth.cleared).toEqual([]);
    });

    it('clears the throttle when an account is authenticated', async () => {
        const reauth = new SpyReauth();
        const job = new SyncPhotosJob(source(true), store, archive, silentLogger, settings, reauth, accounts);

        await job.run({ metadataOnly: true, accountId: ACCOUNT_ID });

        expect(reauth.notified).toEqual([]);
        expect(reauth.cleared).toEqual([ACCOUNT_ID]);
    });
});
