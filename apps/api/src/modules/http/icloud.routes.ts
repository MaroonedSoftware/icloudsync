import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { z } from 'zod';
import { ICloudService } from '../icloud/icloud.service.js';
import { accountParam, withICloudErrors } from './route.helpers.js';

const loginSchema = z.object({ password: z.string().min(1) });
const securityCodeSchema = z.object({ code: z.string().min(4) });
const phoneRequestSchema = z.object({ phoneId: z.coerce.number().int() });
const phoneCodeSchema = z.object({ phoneId: z.coerce.number().int(), code: z.string().min(4) });

/**
 * Router for the iCloud authentication lifecycle across **multiple** accounts.
 * Every account-scoped route names the Apple ID in its path
 * (`/icloud/accounts/:account/…`), so several accounts can be managed (and be
 * mid-2FA) independently.
 *
 * - `GET /icloud/accounts` → `{ accounts: [{ account, authenticated }] }` — the
 *   registered accounts and whether each has a usable session loaded.
 * - `POST /icloud/accounts/:account/login` `{ password }` → `{ state:
 *   'authenticated' }` when the trust token still covers this device, or
 *   `{ state: 'mfaRequired' }` when a security code must be submitted next. The
 *   account is registered, so later calls (and restarts) reuse it.
 * - Complete the second factor one of two ways:
 *   - `POST /icloud/accounts/:account/2fa/device` to push a code to the trusted
 *     devices, then `POST /icloud/accounts/:account/2fa` `{ code }` to submit it, or
 *   - `GET /icloud/accounts/:account/2fa/options` → pick a phone → `POST
 *     /icloud/accounts/:account/2fa/phone` `{ phoneId }` to send an SMS → `POST
 *     /icloud/accounts/:account/2fa/phone/verify` `{ phoneId, code }`.
 *
 * Both completion paths resolve to `{ state: 'authenticated' }`.
 *
 * `GET /icloud/accounts/:account/status` reports one account's session state.
 * `POST /icloud/accounts/:account/logout` forgets the session but keeps the
 * account registered; `DELETE /icloud/accounts/:account` removes it entirely.
 */
export function icloudAuthRouter() {
    const router = ServerKitRouter();
    const json = bodyParserMiddleware(['application/json']);

    router.get('/icloud/accounts', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        ctx.body = { accounts: await icloud.accountsStatus() };
    });

    router.get('/icloud/accounts/:account/status', ctx => {
        const icloud = ctx.container.get(ICloudService);
        const account = accountParam(ctx);
        ctx.body = { account, authenticated: icloud.isAuthenticated(account) };
    });

    router.post('/icloud/accounts/:account/login', json, async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const account = accountParam(ctx);
        const { password } = await parseAndValidate(ctx.body, loginSchema);
        ctx.body = await withICloudErrors(() => icloud.login(account, password));
    });

    router.post('/icloud/accounts/:account/2fa', json, async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const account = accountParam(ctx);
        const { code } = await parseAndValidate(ctx.body, securityCodeSchema);
        ctx.body = await withICloudErrors(() => icloud.submitSecurityCode(account, code));
    });

    router.get('/icloud/accounts/:account/2fa/options', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const account = accountParam(ctx);
        ctx.body = await withICloudErrors(() => icloud.getTwoFactorOptions(account));
    });

    router.post('/icloud/accounts/:account/2fa/device', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const account = accountParam(ctx);
        await withICloudErrors(() => icloud.requestDeviceCode(account));
        ctx.body = { requested: true };
    });

    router.post('/icloud/accounts/:account/2fa/phone', json, async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const account = accountParam(ctx);
        const { phoneId } = await parseAndValidate(ctx.body, phoneRequestSchema);
        await withICloudErrors(() => icloud.requestPhoneCode(account, phoneId));
        ctx.body = { requested: true, phoneId };
    });

    router.post('/icloud/accounts/:account/2fa/phone/verify', json, async ctx => {
        const icloud = ctx.container.get(ICloudService);
        const account = accountParam(ctx);
        const { phoneId, code } = await parseAndValidate(ctx.body, phoneCodeSchema);
        ctx.body = await withICloudErrors(() => icloud.submitPhoneCode(account, code, phoneId));
    });

    router.post('/icloud/accounts/:account/logout', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        await icloud.logout(accountParam(ctx));
        ctx.body = { state: 'loggedOut' };
    });

    router.delete('/icloud/accounts/:account', async ctx => {
        const icloud = ctx.container.get(ICloudService);
        await icloud.remove(accountParam(ctx));
        ctx.body = { state: 'removed' };
    });

    return router;
}
