import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { z } from 'zod';
import { ICloudService } from '../icloud/icloud.service.js';
import { accountIdParam, withICloudErrors } from './route.helpers.js';

const createSchema = z.object({ accountName: z.string().trim().min(3), password: z.string().min(1) });
const securityCodeSchema = z.object({ code: z.string().min(4) });
const phoneRequestSchema = z.object({ phoneId: z.coerce.number().int() });
const phoneCodeSchema = z.object({ phoneId: z.coerce.number().int(), code: z.string().min(4) });

/**
 * Router for the iCloud authentication lifecycle across **multiple** accounts.
 * An account is created (and its login begun) by its Apple ID at
 * `POST /icloud/accounts`, which returns the account's UUID; every other
 * account-scoped route then names that id in its path
 * (`/icloud/accounts/:accountId/…`), so several accounts can be managed (and be
 * mid-2FA) independently.
 *
 * - `GET /icloud/accounts` → `{ accounts: [{ id, account, authenticated }] }` —
 *   the registered accounts (id + Apple ID) and whether each has a usable
 *   session loaded.
 * - `POST /icloud/accounts` `{ accountName, password }` → `{ id, state:
 *   'authenticated' }` when the trust token still covers this device, or
 *   `{ id, state: 'mfaRequired' }` when a security code must be submitted next.
 *   The account is registered under `id`, so later calls (and restarts) reuse it.
 * - Complete the second factor one of two ways, addressing the account by `id`:
 *   - `POST /icloud/accounts/:accountId/2fa/device` to push a code to the trusted
 *     devices, then `POST /icloud/accounts/:accountId/2fa` `{ code }` to submit it, or
 *   - `GET /icloud/accounts/:accountId/2fa/options` → pick a phone → `POST
 *     /icloud/accounts/:accountId/2fa/phone` `{ phoneId }` to send an SMS → `POST
 *     /icloud/accounts/:accountId/2fa/phone/verify` `{ phoneId, code }`.
 *
 * Both completion paths resolve to `{ state: 'authenticated' }`.
 *
 * `GET /icloud/accounts/:accountId/status` reports one account's session state.
 * `POST /icloud/accounts/:accountId/logout` forgets the session but keeps the
 * account registered; `DELETE /icloud/accounts/:accountId` removes it entirely.
 */
export function icloudAuthRouter() {
    const router = ServerKitRouter();
    const json = bodyParserMiddleware(['application/json']);

    router.get('/icloud/accounts', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        ctx.body = { accounts: await icloud.accountsStatus() };
    });

    router.post('/icloud/accounts', json, async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const { accountName, password } = await parseAndValidate(ctx.body, createSchema);
        ctx.body = await withICloudErrors(() => icloud.login(accountName, password));
    });

    router.get('/icloud/accounts/:accountId/status', ctx => {
        const icloud = ctx.container.get(ICloudService);
        const id = accountIdParam(ctx);
        ctx.body = { id, authenticated: icloud.isAuthenticated(id) };
    });

    router.post('/icloud/accounts/:accountId/2fa', json, async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const id = accountIdParam(ctx);
        const { code } = await parseAndValidate(ctx.body, securityCodeSchema);
        ctx.body = await withICloudErrors(() => icloud.submitSecurityCode(id, code));
    });

    router.get('/icloud/accounts/:accountId/2fa/options', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const id = accountIdParam(ctx);
        ctx.body = await withICloudErrors(() => icloud.getTwoFactorOptions(id));
    });

    router.post('/icloud/accounts/:accountId/2fa/device', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const id = accountIdParam(ctx);
        await withICloudErrors(() => icloud.requestDeviceCode(id));
        ctx.body = { requested: true };
    });

    router.post('/icloud/accounts/:accountId/2fa/phone', json, async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const id = accountIdParam(ctx);
        const { phoneId } = await parseAndValidate(ctx.body, phoneRequestSchema);
        await withICloudErrors(() => icloud.requestPhoneCode(id, phoneId));
        ctx.body = { requested: true, phoneId };
    });

    router.post('/icloud/accounts/:accountId/2fa/phone/verify', json, async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const id = accountIdParam(ctx);
        const { phoneId, code } = await parseAndValidate(ctx.body, phoneCodeSchema);
        ctx.body = await withICloudErrors(() => icloud.submitPhoneCode(id, code, phoneId));
    });

    router.post('/icloud/accounts/:accountId/logout', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        await icloud.logout(accountIdParam(ctx));
        ctx.body = { state: 'loggedOut' };
    });

    router.delete('/icloud/accounts/:accountId', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        await icloud.remove(accountIdParam(ctx));
        ctx.body = { state: 'removed' };
    });

    return router;
}
