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
import { NotificationsService, notificationSettingsPatchSchema } from '../notifications/index.js';
import { accountIdParam } from './route.helpers.js';

/** A 5-field cron expression (minute hour day month weekday). */
const cronSchema = z
    .string()
    .trim()
    .refine(value => value.split(/\s+/).length === 5, { message: 'expected a 5-field cron expression' });

const updateSchema = z
    .object({
        photosLayout: z.enum(PHOTO_LAYOUTS).optional(),
        photosNaming: z.enum(PHOTO_NAMINGS).optional(),
        syncCron: cronSchema.optional(),
        notifications: notificationSettingsPatchSchema.optional(),
    })
    .refine(body => Object.values(body).some(v => v !== undefined), {
        message: 'no settings provided',
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
 * Per-account overrides for the on-disk organization. Any field may be `null`
 * to clear the override (fall back to the default) or a valid value to pin it;
 * at least one must be present.
 */
const accountSettingsSchema = z
    .object({
        photosLayout: z.enum(PHOTO_LAYOUTS).nullable().optional(),
        photosNaming: z.enum(PHOTO_NAMINGS).nullable().optional(),
        archivePrefix: archivePrefixSchema.optional(),
    })
    .refine(body => body.photosLayout !== undefined || body.photosNaming !== undefined || body.archivePrefix !== undefined, {
        message: 'no settings provided',
    });

/**
 * Router for the database-backed runtime settings (photo layout, sync schedule,
 * and admin notifications, all global across accounts). Changing the schedule
 * reschedules the pg-boss cron immediately, so it takes effect without a restart.
 *
 * - `GET /icloud/settings` → `{ photosLayout, photosNaming, syncCron, notifications }`.
 * - `PATCH /icloud/settings` `{ photosLayout?, photosNaming?, syncCron?, notifications? }` → the updated settings.
 * - `POST /icloud/notifications/test` → `{ sent: true }` after delivering a test
 *   notification over the configured channel (422 with the error if it fails).
 *
 * Per-account overrides inherit the global default (layout/naming) or the
 * account id (archive prefix) unless pinned, keyed by account id in the path:
 * - `GET /icloud/accounts/:accountId/settings` → `{ photosLayout, photosNaming,
 *   archivePrefix, defaults }` — the account's overrides (`null` = inherit) plus
 *   the global values layout/naming fall back to.
 * - `PATCH /icloud/accounts/:accountId/settings` `{ photosLayout?, photosNaming?,
 *   archivePrefix? }` — a value pins the override, `null` (or `''` for the prefix)
 *   clears it; returns the same shape as GET.
 */
export function icloudSettingsRouter() {
    const router = ServerKitRouter();
    const json = bodyParserMiddleware(['application/json']);

    /** The account-settings view (overrides + the global defaults layout/naming inherit + live relocation state). */
    const accountSettingsView = async (accountId: string, container: Container) => {
        const accounts = container.get(AccountsService);
        const settings = container.get(SettingsService);
        const relocate = container.get(RelocateRegistry);
        const [override, account, photosLayout, photosNaming, relocatingId] = await Promise.all([
            accounts.photoSettings(accountId),
            accounts.getById(accountId),
            settings.photosLayout(),
            settings.photosNaming(),
            inFlightJobId(container.get(JobBroker), RELOCATE_ARCHIVE_JOB, relocate.jobId(accountId)),
        ]);
        return {
            photosLayout: override.layout,
            photosNaming: override.naming,
            archivePrefix: account?.archivePrefix ?? null,
            // True while a prefix change's file move is still queued or running.
            relocating: relocatingId !== undefined,
            // The last move's failure summary, or null if it succeeded / none ran.
            relocationError: account?.relocationError ?? null,
            defaults: { photosLayout, photosNaming },
        };
    };

    router.get('/icloud/settings', async ctx => {
        const settings = ctx.container.get(SettingsService);
        ctx.body = await settings.all();
    });

    router.patch('/icloud/settings', json, async ctx => {
        const settings = ctx.container.get(SettingsService);
        const { photosLayout, photosNaming, syncCron, notifications } = await parseAndValidate(ctx.body, updateSchema);

        if (photosLayout !== undefined) await settings.setPhotosLayout(photosLayout);
        if (photosNaming !== undefined) await settings.setPhotosNaming(photosNaming);
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
        if (patch.photosLayout !== undefined) update.layout = patch.photosLayout;
        if (patch.photosNaming !== undefined) update.naming = patch.photosNaming;
        await accounts.setPhotoSettings(accountId, update);

        if (patch.archivePrefix !== undefined) {
            // An empty string clears the prefix back to the default (the account id).
            const newPrefix = patch.archivePrefix || null;
            const before = account.archivePrefix ?? accountId; // effective old prefix
            const after = newPrefix ?? accountId; // effective new prefix
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
        const to = account.archivePrefix ?? accountId;
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
