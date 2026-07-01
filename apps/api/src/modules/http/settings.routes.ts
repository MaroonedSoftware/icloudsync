import { JobBroker } from '@maroonedsoftware/jobbroker';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { z } from 'zod';
import { SettingsService } from '../settings/settings.service.js';
import { SYNC_SWEEP_JOB } from '../icloud/sync/sync.dispatch.js';
import { PHOTO_LAYOUTS } from '../icloud/storage/photo.layout.js';
import { NotificationsService, notificationSettingsPatchSchema } from '../notifications/index.js';

/** A 5-field cron expression (minute hour day month weekday). */
const cronSchema = z
    .string()
    .trim()
    .refine(value => value.split(/\s+/).length === 5, { message: 'expected a 5-field cron expression' });

const updateSchema = z
    .object({
        photosLayout: z.enum(PHOTO_LAYOUTS).optional(),
        syncCron: cronSchema.optional(),
        notifications: notificationSettingsPatchSchema.optional(),
    })
    .refine(body => body.photosLayout !== undefined || body.syncCron !== undefined || body.notifications !== undefined, {
        message: 'no settings provided',
    });

/**
 * Router for the database-backed runtime settings (photo layout, sync schedule,
 * and admin notifications, all global across accounts). Changing the schedule
 * reschedules the pg-boss cron immediately, so it takes effect without a restart.
 *
 * - `GET /icloud/settings` → `{ photosLayout, syncCron, notifications }`.
 * - `PATCH /icloud/settings` `{ photosLayout?, syncCron?, notifications? }` → the updated settings.
 * - `POST /icloud/notifications/test` → `{ sent: true }` after delivering a test
 *   notification over the configured channel (422 with the error if it fails).
 */
export function icloudSettingsRouter() {
    const router = ServerKitRouter();
    const json = bodyParserMiddleware(['application/json']);

    router.get('/icloud/settings', async ctx => {
        const settings = ctx.container.get(SettingsService);
        ctx.body = await settings.all();
    });

    router.patch('/icloud/settings', json, async ctx => {
        const settings = ctx.container.get(SettingsService);
        const { photosLayout, syncCron, notifications } = await parseAndValidate(ctx.body, updateSchema);

        if (photosLayout !== undefined) await settings.setPhotosLayout(photosLayout);
        if (syncCron !== undefined) {
            await settings.setSyncCron(syncCron);
            // Re-arm the pg-boss cron (on the sweep that fans out per-account jobs)
            // so the new schedule applies without a restart.
            await ctx.container.get(JobBroker).schedule(SYNC_SWEEP_JOB, syncCron);
        }
        if (notifications !== undefined) await settings.setNotifications(notifications);

        ctx.body = await settings.all();
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
