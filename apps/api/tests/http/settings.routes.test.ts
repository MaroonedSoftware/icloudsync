import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { createRegistry } from 'injectkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeServer } from '../_helpers/server.js';
import { registerBodyParser } from '../../src/modules/http/body.parser.js';
import { createApiApp } from '../../src/modules/http/server.js';
import { SettingsService } from '../../src/modules/settings/settings.service.js';
import { AccountsService, type AccountPhotoSettings } from '../../src/modules/accounts/index.js';
import { RelocateRegistry } from '../../src/modules/icloud/sync/relocate.registry.js';
import { ImmichProbe, type ImmichConnection } from '../../src/modules/icloud/storage/immich.probe.js';
import { NotificationsService } from '../../src/modules/notifications/index.js';
import type { NotificationSettings, NotificationSettingsPatch } from '../../src/modules/notifications/index.js';
import type { ImmichSettings } from '../../src/modules/icloud/storage/photo.destination.js';

const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} } as Logger;

const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ID = '55555555-5555-4555-8555-555555555555';

class FakeSettings {
    cron = '0 */6 * * *';
    notifications: NotificationSettings = { channel: 'none', throttleHours: 24 };
    immichValue: ImmichSettings | null = null;
    all = () =>
        Promise.resolve({
            immich: this.immichValue,
            syncCron: this.cron,
            notifications: this.notifications,
        });
    immich = () => Promise.resolve(this.immichValue);
    setImmich = (v: ImmichSettings | null) => {
        this.immichValue = v;
        return Promise.resolve(v);
    };
    setSyncCron = (c: string) => {
        this.cron = c;
        return Promise.resolve();
    };
    setNotifications = (patch: NotificationSettingsPatch) => {
        this.notifications = { ...this.notifications, ...patch };
        return Promise.resolve(this.notifications);
    };
}

class FakeAccounts {
    // account → its overrides (null field = inherit the default)
    readonly overrides = new Map<string, AccountPhotoSettings>();
    readonly prefixes = new Map<string, string | null>();
    readonly relocationErrors = new Map<string, string | null>();
    readonly relocationFroms = new Map<string, string | null>();
    readonly registered = new Set<string>([ACCOUNT_ID]);
    has = (account: string) => Promise.resolve(this.registered.has(account));
    getById = (id: string) =>
        Promise.resolve(
            this.registered.has(id)
                ? {
                      id,
                      accountName: 'a@icloud.com',
                      archivePrefix: this.prefixes.get(id) ?? null,
                      relocationError: this.relocationErrors.get(id) ?? null,
                      relocationFrom: this.relocationFroms.get(id) ?? null,
                  }
                : undefined,
        );
    photoSettings = (account: string) => Promise.resolve(this.overrides.get(account) ?? { destination: null, preset: null, layout: null, naming: null });
    setPhotoSettings = (account: string, patch: Partial<AccountPhotoSettings>) => {
        const current = this.overrides.get(account) ?? { destination: null, preset: null, layout: null, naming: null };
        this.overrides.set(account, { ...current, ...patch });
        return Promise.resolve();
    };
    setArchivePrefix = (account: string, archivePrefix: string | null) => {
        this.prefixes.set(account, archivePrefix);
        return Promise.resolve();
    };
    setRelocationState = (account: string, error: string | null, resumeFrom: string | null) => {
        this.relocationErrors.set(account, error);
        this.relocationFroms.set(account, resumeFrom);
        return Promise.resolve();
    };
}

class FakeNotifications {
    tests = 0;
    failWith?: string;
    sendTest = () => {
        this.tests += 1;
        return this.failWith ? Promise.reject(new Error(this.failWith)) : Promise.resolve();
    };
}

class FakeImmichProbe {
    /** The connections it was asked to check, in order. */
    readonly checked: ImmichConnection[] = [];
    /** When set, every check reports this failure message; otherwise checks pass. */
    failWith?: string;
    check = (connection: ImmichConnection) => {
        this.checked.push(connection);
        return Promise.resolve(this.failWith ? { ok: false, message: this.failWith } : { ok: true });
    };
}

class FakeBroker {
    scheduled: Array<{ name: string; cron: string }> = [];
    sent: Array<{ name: string; payload: unknown }> = [];
    private readonly jobs = new Map<string, { name: string; state: string }>();
    private seq = 0;
    send = (name: string, payload: unknown) => {
        this.sent.push({ name, payload });
        this.seq += 1;
        const id = `job-${this.seq}`;
        this.jobs.set(id, { name, state: 'created' }); // queued -> in flight
        return Promise.resolve(id);
    };
    getJob = (name: string, id: string) => {
        const job = this.jobs.get(id);
        return Promise.resolve(job && job.name === name ? { id, ...job } : null);
    };
    /** Test helper: mark a queued job finished so it reads as no longer in flight. */
    complete = (id: string) => {
        const job = this.jobs.get(id);
        if (job) job.state = 'completed';
    };
    schedule = (name: string, cron: string) => {
        this.scheduled.push({ name, cron });
        return Promise.resolve();
    };
    unschedule = () => Promise.resolve();
}

describe('icloud settings routes', () => {
    let server: Server;
    let base: string;
    let settings: FakeSettings;
    let broker: FakeBroker;
    let notifications: FakeNotifications;
    let accounts: FakeAccounts;
    let immichProbe: FakeImmichProbe;

    beforeEach(() => {
        settings = new FakeSettings();
        broker = new FakeBroker();
        notifications = new FakeNotifications();
        accounts = new FakeAccounts();
        immichProbe = new FakeImmichProbe();
        const registry = createRegistry();
        registry.register(Logger).useInstance(silentLogger);
        registerBodyParser(registry);
        registry.register(SettingsService).useInstance(settings as unknown as SettingsService);
        registry.register(AccountsService).useInstance(accounts as unknown as AccountsService);
        registry.register(RelocateRegistry).useInstance(new RelocateRegistry());
        registry.register(JobBroker).useInstance(broker as unknown as JobBroker);
        registry.register(NotificationsService).useInstance(notifications as unknown as NotificationsService);
        registry.register(ImmichProbe).useInstance(immichProbe as unknown as ImmichProbe);

        server = createApiApp(registry.build()).listen(0);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(() => closeServer(server));

    const patch = (body: unknown) =>
        fetch(`${base}/icloud/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('returns the current settings', async () => {
        const res = await fetch(`${base}/icloud/settings`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            immich: null,
            syncCron: '0 */6 * * *',
            notifications: { channel: 'none', throttleHours: 24 },
        });
    });

    it('sets the global Immich connection, defaulting the reconcile flags', async () => {
        const res = await patch({ immich: { baseUrl: 'https://immich.test', apiKey: 'secret' } });
        expect(res.status).toBe(200);
        expect(settings.immichValue).toEqual({
            baseUrl: 'https://immich.test',
            apiKey: 'secret',
            recreateAlbums: true,
            syncFavorites: true,
        });
    });

    it('clears the Immich connection when passed null', async () => {
        settings.immichValue = { baseUrl: 'https://immich.test', apiKey: 'k', recreateAlbums: true, syncFavorites: true };
        const res = await patch({ immich: null });
        expect(res.status).toBe(200);
        expect(settings.immichValue).toBeNull();
    });

    it('rejects an Immich connection with a bad URL with 400', async () => {
        const res = await patch({ immich: { baseUrl: 'nope', apiKey: 'k' } });
        expect(res.status).toBe(400);
    });

    const testImmich = (body: unknown) =>
        fetch(`${base}/icloud/immich/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('tests the provided Immich connection and reports success', async () => {
        const res = await testImmich({ baseUrl: 'https://immich.test', apiKey: 'k' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(immichProbe.checked).toEqual([{ baseUrl: 'https://immich.test', apiKey: 'k' }]);
    });

    it('falls back to the stored Immich connection when the body is empty', async () => {
        settings.immichValue = { baseUrl: 'https://saved.test', apiKey: 'saved-key', recreateAlbums: true, syncFavorites: true };
        const res = await testImmich({});
        expect(res.status).toBe(200);
        expect(immichProbe.checked).toEqual([{ baseUrl: 'https://saved.test', apiKey: 'saved-key', recreateAlbums: true, syncFavorites: true }]);
    });

    it('422s an empty-body test when no connection is stored', async () => {
        const res = await testImmich({});
        expect(res.status).toBe(422);
        expect((await res.json()).ok).toBe(false);
        expect(immichProbe.checked).toHaveLength(0); // never probed — nothing to test
    });

    it('reports a failed probe as 422 with the reason', async () => {
        immichProbe.failWith = 'the API key was rejected';
        const res = await testImmich({ baseUrl: 'https://immich.test', apiKey: 'bad' });
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ ok: false, message: 'the API key was rejected' });
    });

    it('rejects a test with a malformed URL with 400', async () => {
        const res = await testImmich({ baseUrl: 'nope', apiKey: 'k' });
        expect(res.status).toBe(400);
    });

    it('updates the schedule and re-arms the cron', async () => {
        const res = await patch({ syncCron: '0 3 * * *' });
        expect(res.status).toBe(200);
        expect(settings.cron).toBe('0 3 * * *');
        expect(broker.scheduled).toEqual([{ name: 'icloud/sync-sweep', cron: '0 3 * * *' }]);
    });

    it('rejects an invalid cron expression with 400', async () => {
        const res = await patch({ syncCron: '0 3 * *' }); // only 4 fields
        expect(res.status).toBe(400);
        expect(settings.cron).toBe('0 */6 * * *');
    });

    it('rejects an empty update with 400', async () => {
        const res = await patch({});
        expect(res.status).toBe(400);
    });

    it('updates the notification config', async () => {
        const res = await patch({ notifications: { channel: 'webhook', webhookUrl: 'https://hook.example/x' } });
        expect(res.status).toBe(200);
        expect(settings.notifications.channel).toBe('webhook');
        expect((await res.json()).notifications.webhookUrl).toBe('https://hook.example/x');
    });

    it('rejects an invalid webhook URL with 400', async () => {
        const res = await patch({ notifications: { channel: 'webhook', webhookUrl: 'not-a-url' } });
        expect(res.status).toBe(400);
    });

    const accountUrl = (account: string) => `${base}/icloud/accounts/${encodeURIComponent(account)}/settings`;
    const patchAccount = (account: string, body: unknown) =>
        fetch(accountUrl(account), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('returns an account\'s overrides and the built-in defaults it falls back to', async () => {
        const res = await fetch(accountUrl(ACCOUNT_ID));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            photosDestination: null,
            photosPreset: null,
            photosLayout: null,
            photosNaming: null,
            archivePrefix: null,
            defaultPrefix: 'a', // from the Apple ID a@icloud.com
            relocating: false,
            relocationError: null,
            defaults: { photosDestination: 'filesystem', photosPreset: 'immich', photosLayout: 'flat', photosNaming: 'clean' },
            immichConfigured: false,
        });
    });

    it('reflects a configured Immich connection and an account routed to it', async () => {
        settings.immichValue = { baseUrl: 'https://immich.test', apiKey: 'k', recreateAlbums: true, syncFavorites: true };
        const pinned = await patchAccount(ACCOUNT_ID, { photosDestination: 'immich', photosPreset: 'browsable' });
        expect(pinned.status).toBe(200);
        const body = await pinned.json();
        expect(body.photosDestination).toBe('immich');
        expect(body.photosPreset).toBe('browsable');
        expect(body.immichConfigured).toBe(true);
        expect(accounts.overrides.get(ACCOUNT_ID)).toEqual({ destination: 'immich', preset: 'browsable', layout: null, naming: null });
    });

    it('pins and clears a custom archive prefix', async () => {
        const pinned = await patchAccount(ACCOUNT_ID, { archivePrefix: 'family-photos' });
        expect(pinned.status).toBe(200);
        expect((await pinned.json()).archivePrefix).toBe('family-photos');
        expect(accounts.prefixes.get(ACCOUNT_ID)).toBe('family-photos');

        // An empty string clears it back to the default.
        const cleared = await patchAccount(ACCOUNT_ID, { archivePrefix: '' });
        expect(cleared.status).toBe(200);
        expect((await cleared.json()).archivePrefix).toBeNull();
        expect(accounts.prefixes.get(ACCOUNT_ID)).toBeNull();
    });

    it('rejects an archive prefix with path traversal with 400', async () => {
        const res = await patchAccount(ACCOUNT_ID, { archivePrefix: '../escape' });
        expect(res.status).toBe(400);
    });

    it('enqueues an archive relocation when the prefix changes and reports it in flight', async () => {
        // Seed a stale failure from a prior move; starting a fresh one clears it.
        accounts.relocationErrors.set(ACCOUNT_ID, 'old failure');

        const res = await patchAccount(ACCOUNT_ID, { archivePrefix: 'family' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.archivePrefix).toBe('family');
        expect(body.relocating).toBe(true); // the queued move is tracked and reported
        expect(body.relocationError).toBeNull(); // the fresh attempt cleared the prior failure

        // The move runs off the request thread: a relocation job is queued with the
        // effective old (the default = the Apple ID's local part 'a') and new prefixes.
        expect(broker.sent).toEqual([{ name: 'icloud/relocate-archive', payload: { accountId: ACCOUNT_ID, fromPrefix: 'a', toPrefix: 'family' } }]);

        // Once the job leaves the in-flight states, the view reports it as done.
        broker.complete('job-1');
        expect((await (await fetch(accountUrl(ACCOUNT_ID))).json()).relocating).toBe(false);
    });

    it('does not enqueue a relocation when the prefix is unchanged', async () => {
        // Patch only the layout — the (default) prefix is untouched, so nothing relocates.
        await patchAccount(ACCOUNT_ID, { photosLayout: 'album' });
        expect(broker.sent).toEqual([]);
    });

    const retryUrl = (account: string) => `${base}/icloud/accounts/${encodeURIComponent(account)}/relocate/retry`;

    it('resumes a failed relocation from the recorded source to the current prefix', async () => {
        // A prior move id → family failed part-way: prefix is already family, source id remembered.
        accounts.prefixes.set(ACCOUNT_ID, 'family');
        accounts.relocationFroms.set(ACCOUNT_ID, ACCOUNT_ID);
        accounts.relocationErrors.set(ACCOUNT_ID, 'Moved 1 file(s); 1 failed to move: boom');

        const res = await fetch(retryUrl(ACCOUNT_ID), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.relocating).toBe(true);
        expect(body.relocationError).toBeNull();

        expect(broker.sent).toEqual([{ name: 'icloud/relocate-archive', payload: { accountId: ACCOUNT_ID, fromPrefix: ACCOUNT_ID, toPrefix: 'family' } }]);
    });

    it('retry is a no-op (just clears any stale error) when there is nothing to resume', async () => {
        accounts.relocationErrors.set(ACCOUNT_ID, 'stale');
        const res = await fetch(retryUrl(ACCOUNT_ID), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.relocating).toBe(false);
        expect(body.relocationError).toBeNull();
        expect(broker.sent).toEqual([]);
    });

    it('pins and clears an account override', async () => {
        const pinned = await patchAccount(ACCOUNT_ID, { photosLayout: 'album' });
        expect(pinned.status).toBe(200);
        expect((await pinned.json()).photosLayout).toBe('album');
        expect(accounts.overrides.get(ACCOUNT_ID)).toEqual({ destination: null, preset: null, layout: 'album', naming: null });

        const cleared = await patchAccount(ACCOUNT_ID, { photosLayout: null });
        expect(cleared.status).toBe(200);
        expect((await cleared.json()).photosLayout).toBeNull();
        expect(accounts.overrides.get(ACCOUNT_ID)?.layout).toBeNull();
    });

    it('rejects an invalid override value with 400', async () => {
        const res = await patchAccount(ACCOUNT_ID, { photosNaming: 'bogus' });
        expect(res.status).toBe(400);
    });

    it('rejects an empty account update with 400', async () => {
        const res = await patchAccount(ACCOUNT_ID, {});
        expect(res.status).toBe(400);
    });

    it('404s for an unregistered account', async () => {
        const get = await fetch(accountUrl(OTHER_ID));
        expect(get.status).toBe(404);
        const patch = await patchAccount(OTHER_ID, { photosLayout: 'flat' });
        expect(patch.status).toBe(404);
    });

    it('sends a test notification', async () => {
        const res = await fetch(`${base}/icloud/notifications/test`, { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ sent: true });
        expect(notifications.tests).toBe(1);
    });

    it('reports a failed test notification as 422 with the error message', async () => {
        notifications.failWith = 'webhook responded 500';
        const res = await fetch(`${base}/icloud/notifications/test`, { method: 'POST' });
        expect(res.status).toBe(422);
        expect((await res.json()).message).toBe('webhook responded 500');
    });
});
