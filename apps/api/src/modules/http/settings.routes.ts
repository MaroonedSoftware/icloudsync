import { HttpError } from '@maroonedsoftware/errors';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { parseAndValidate } from '@maroonedsoftware/zod';
import type { Container } from 'injectkit';
import { z } from 'zod';
import { AccountsService, type AccountPhotoSettings } from '../accounts/index.js';
import { SettingsService } from '../settings/settings.service.js';
import { SYNC_SWEEP_JOB } from '../icloud/sync/sync.dispatch.js';
import { RELOCATE_ARCHIVE_JOB } from '../icloud/sync/relocate.archive.job.js';
import { RelocateRegistry } from '../icloud/sync/relocate.registry.js';
import { inFlightJobId } from '../icloud/sync/job.status.js';
import { PHOTO_LAYOUTS } from '../icloud/storage/photo.layout.js';
import { PHOTO_NAMINGS } from '../icloud/storage/photo.naming.js';
import {
    DEFAULT_DESTINATION_KIND,
    DEFAULT_FILESYSTEM_PRESET,
    DESTINATION_KINDS,
    FILESYSTEM_PRESETS,
    immichSettingsSchema,
    PRESET_MECHANICS,
} from '../icloud/storage/photo.destination.js';
import { defaultArchivePrefix } from '../icloud/storage/photo.prefix.js';
import { ImmichProbe } from '../icloud/storage/immich.probe.js';
import { NotificationsService, notificationSettingsPatchSchema } from '../notifications/index.js';
import { accountIdParam } from './route.helpers.js';

/** A 5-field cron expression (minute hour day month weekday). */
const cronSchema = z
    .string()
    .trim()
    .refine(value => value.split(/\s+/).length === 5, { message: 'expected a 5-field cron expression' });

const updateSchema = z
    .object({
        // The global Immich connection: a full config to set it, or `null` to clear it.
        immich: immichSettingsSchema.nullable().optional(),
        syncCron: cronSchema.optional(),
        notifications: notificationSettingsPatchSchema.optional(),
    })
    .refine(body => Object.values(body).some(v => v !== undefined), {
        message: 'no settings provided',
    });

/**
 * Body for the Immich connection test. Both fields present → test those values (an
 * unsaved edit in the form); both omitted → test the stored connection (used by
 * the settings page's on-load status check). A partial body is treated as "test
 * the stored connection".
 */
const immichTestSchema = z.object({
    baseUrl: z.string().trim().url().optional(),
    apiKey: z.string().trim().min(1).optional(),
});

/**
 * A custom photo-archive path prefix: a safe relative path segment (no leading
 * slash, no `..` traversal, no backslashes or control characters). An empty
 * string clears the override; `null` clears it too.
 */
const archivePrefixSchema = z
    .string()
    .trim()
    .max(200)
    .refine(v => v === '' || (!v.startsWith('/') && !v.includes('..') && !v.includes('\\') && ![...v].some(c => c.charCodeAt(0) < 0x20)), {
        message: 'invalid archive prefix',
    })
    .nullable();

/**
 * Per-account overrides for the backup destination and on-disk organization. Any
 * field may be `null` to clear the override (fall back to the default) or a valid
 * value to pin it; at least one must be present.
 */
const accountSettingsSchema = z
    .object({
        photosDestination: z.enum(DESTINATION_KINDS).nullable().optional(),
        photosPreset: z.enum(FILESYSTEM_PRESETS).nullable().optional(),
        photosLayout: z.enum(PHOTO_LAYOUTS).nullable().optional(),
        photosNaming: z.enum(PHOTO_NAMINGS).nullable().optional(),
        archivePrefix: archivePrefixSchema.optional(),
    })
    .refine(
        body =>
            body.photosDestination !== undefined ||
            body.photosPreset !== undefined ||
            body.photosLayout !== undefined ||
            body.photosNaming !== undefined ||
            body.archivePrefix !== undefined,
        { message: 'no settings provided' },
    );

/**
 * Router for the database-backed runtime settings. Global across accounts: the
 * Immich connection, the sync schedule, and admin notifications. Changing the
 * schedule reschedules the pg-boss cron immediately, so it takes effect without a restart.
 *
 * - `GET /icloud/settings` → `{ immich, syncCron, notifications }` (`immich` is
 *   `null` when no connection is configured).
 * - `PATCH /icloud/settings` `{ immich?, syncCron?, notifications? }` → the updated
 *   settings. `immich` is the shared Immich connection — a full
 *   `{ baseUrl, apiKey, recreateAlbums, syncFavorites }` to set it, or `null` to clear it.
 * - `POST /icloud/immich/test` `{ baseUrl?, apiKey? }` → `{ ok: true }` when the
 *   Immich server is reachable and the API key is accepted, else 422
 *   `{ ok: false, message }`. Both fields test those values (an unsaved edit);
 *   an empty body tests the stored connection.
 * - `POST /icloud/notifications/test` → `{ sent: true }` after delivering a test
 *   notification over the configured channel (422 with the error if it fails).
 *
 * The backup destination (filesystem preset vs Immich upload) and on-disk
 * layout/naming are per-account. Per-account overrides inherit the built-in
 * defaults (filesystem, `immich` preset, its flat/clean baseline) or the Apple
 * ID's local part (archive prefix) unless pinned, keyed by account id in the path:
 * - `GET /icloud/accounts/:accountId/settings` → `{ photosDestination, photosPreset,
 *   photosLayout, photosNaming, archivePrefix, defaultPrefix, defaults,
 *   immichConfigured }` — the account's overrides (`null` = inherit) plus the
 *   defaults they fall back to.
 * - `PATCH /icloud/accounts/:accountId/settings` `{ photosDestination?, photosPreset?,
 *   photosLayout?, photosNaming?, archivePrefix? }` — a value pins the override,
 *   `null` (or `''` for the prefix) clears it; returns the same shape as GET.
 */
export function icloudSettingsRouter() {
    const router = ServerKitRouter();
    const json = bodyParserMiddleware(['application/json']);

    /** The account-settings view (destination + layout/naming overrides, the defaults they inherit, and live relocation state). */
    const accountSettingsView = async (accountId: string, container: Container) => {
        const accounts = container.get(AccountsService);
        const settings = container.get(SettingsService);
        const relocate = container.get(RelocateRegistry);
        const [override, account, immich, relocatingId] = await Promise.all([
            accounts.photoSettings(accountId),
            accounts.getById(accountId),
            settings.immich(),
            inFlightJobId(container.get(JobBroker), RELOCATE_ARCHIVE_JOB, relocate.jobId(accountId)),
        ]);
        // A null layout/naming override falls back to the effective preset's baseline
        // (immich → flat/clean, browsable → date/clean); an unset preset inherits the default.
        const baseline = PRESET_MECHANICS[override.preset ?? DEFAULT_FILESYSTEM_PRESET];
        return {
            // The account's own overrides; `null` means "inherit the default".
            photosDestination: override.destination,
            photosPreset: override.preset,
            photosLayout: override.layout,
            photosNaming: override.naming,
            archivePrefix: account?.archivePrefix ?? null,
            // The prefix an unset (`null`) archivePrefix defaults to: the Apple
            // ID's local part. Shown to the user as the field's placeholder.
            defaultPrefix: account ? defaultArchivePrefix(account) : null,
            // True while a prefix change's file move is still queued or running.
            relocating: relocatingId !== undefined,
            // The last move's failure summary, or null if it succeeded / none ran.
            relocationError: account?.relocationError ?? null,
            // The values a null override falls back to (built-in destination/preset + the preset baseline).
            defaults: {
                photosDestination: DEFAULT_DESTINATION_KIND,
                photosPreset: DEFAULT_FILESYSTEM_PRESET,
                photosLayout: baseline.layout,
                photosNaming: baseline.naming,
            },
            // Whether a global Immich connection is configured — the UI warns when
            // this account routes to Immich but none is set.
            immichConfigured: immich !== null,
        };
    };

    router.get('/icloud/settings', async ctx => {
        const settings = ctx.container.get(SettingsService);
        ctx.body = await settings.all();
    });

    router.patch('/icloud/settings', json, async ctx => {
        const settings = ctx.container.get(SettingsService);
        const { immich, syncCron, notifications } = await parseAndValidate(ctx.body, updateSchema);

        if (immich !== undefined) await settings.setImmich(immich);
        if (syncCron !== undefined) {
            await settings.setSyncCron(syncCron);
            // Re-arm the pg-boss cron (on the sweep that fans out per-account jobs)
            // so the new schedule applies without a restart.
            await ctx.container.get(JobBroker).schedule(SYNC_SWEEP_JOB, syncCron);
        }
        if (notifications !== undefined) await settings.setNotifications(notifications);

        ctx.body = await settings.all();
    });

    router.get('/icloud/accounts/:accountId/settings', async ctx => {
        const accountId = accountIdParam(ctx);
        const accounts = ctx.container.get(AccountsService);
        if (!(await accounts.has(accountId))) throw new HttpError(404).withDetails({ reason: 'account_not_found' });
        ctx.body = await accountSettingsView(accountId, ctx.container);
    });

    router.patch('/icloud/accounts/:accountId/settings', json, async ctx => {
        const accountId = accountIdParam(ctx);
        const accounts = ctx.container.get(AccountsService);
        const account = await accounts.getById(accountId);
        if (!account) throw new HttpError(404).withDetails({ reason: 'account_not_found' });

        const patch = await parseAndValidate(ctx.body, accountSettingsSchema);
        const update: Partial<AccountPhotoSettings> = {};
        if (patch.photosDestination !== undefined) update.destination = patch.photosDestination;
        if (patch.photosPreset !== undefined) update.preset = patch.photosPreset;
        if (patch.photosLayout !== undefined) update.layout = patch.photosLayout;
        if (patch.photosNaming !== undefined) update.naming = patch.photosNaming;
        await accounts.setPhotoSettings(accountId, update);

        if (patch.archivePrefix !== undefined) {
            // An empty string clears the prefix back to the default (the Apple ID's local part).
            const newPrefix = patch.archivePrefix || null;
            const fallback = defaultArchivePrefix(account);
            const before = account.archivePrefix ?? fallback; // effective old prefix
            const after = newPrefix ?? fallback; // effective new prefix
            await accounts.setArchivePrefix(accountId, newPrefix);
            // Relocate any already-archived files off the request thread (a large
            // library can take a while) so the change doesn't orphan them, and track
            // the job so the settings view can report the move as still in flight.
            if (before !== after) {
                // Clear any prior failure and remember the source so a retry can resume this move.
                await accounts.setRelocationState(accountId, null, before);
                const jobId = await ctx.container.get(JobBroker).send(RELOCATE_ARCHIVE_JOB, { accountId, fromPrefix: before, toPrefix: after });
                if (jobId) ctx.container.get(RelocateRegistry).track(accountId, jobId);
            }
        }

        ctx.body = await accountSettingsView(accountId, ctx.container);
    });

    // Resume a relocation that failed part-way: re-run the recorded move (its stored
    // `relocation_from` → the account's current prefix). Idempotent — already-moved
    // files are skipped — so it just finishes the stragglers. Returns the settings view.
    router.post('/icloud/accounts/:accountId/relocate/retry', async ctx => {
        const accountId = accountIdParam(ctx);
        const accounts = ctx.container.get(AccountsService);
        const account = await accounts.getById(accountId);
        if (!account) throw new HttpError(404).withDetails({ reason: 'account_not_found' });

        const from = account.relocationFrom;
        const to = account.archivePrefix ?? defaultArchivePrefix(account);
        if (from && from !== to) {
            await accounts.setRelocationState(accountId, null, from); // clear the error, keep the source
            const jobId = await ctx.container.get(JobBroker).send(RELOCATE_ARCHIVE_JOB, { accountId, fromPrefix: from, toPrefix: to });
            if (jobId) ctx.container.get(RelocateRegistry).track(accountId, jobId);
        } else {
            // Nothing left to resume — clear any stale error/source.
            await accounts.setRelocationState(accountId, null, null);
        }

        ctx.body = await accountSettingsView(accountId, ctx.container);
    });

    // Test an Immich connection without uploading anything: pings the server and
    // checks the API key. The body carries the in-progress form values (so a
    // connection can be verified before it's saved); an empty body tests the
    // stored connection (the page's on-load status check). Returns `{ ok: true }`
    // on success, or 422 `{ ok: false, message }` on a failed/absent connection.
    router.post('/icloud/immich/test', json, async ctx => {
        const { baseUrl, apiKey } = await parseAndValidate(ctx.body, immichTestSchema);
        const connection = baseUrl && apiKey ? { baseUrl, apiKey } : await ctx.container.get(SettingsService).immich();
        if (!connection) {
            ctx.status = 422;
            ctx.body = { ok: false, message: 'No Immich server is configured.' };
            return;
        }
        const result = await ctx.container.get(ImmichProbe).check(connection);
        if (!result.ok) {
            ctx.status = 422;
            ctx.body = { ok: false, message: result.message ?? 'Connection failed.' };
            return;
        }
        ctx.body = { ok: true };
    });

    router.post('/icloud/notifications/test', async ctx => {
        try {
            await ctx.container.get(NotificationsService).sendTest();
            ctx.body = { sent: true };
        } catch (error) {
            ctx.status = 422;
            ctx.body = { message: error instanceof Error ? error.message : String(error) };
        }
    });

    return router;
}
