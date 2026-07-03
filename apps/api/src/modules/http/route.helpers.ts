import { HttpError } from '@maroonedsoftware/errors';
import type { ServerKitContext } from '@maroonedsoftware/koa';
import { mapICloudError } from './error.mapping.js';

/** Canonical UUID form (any version), used to validate the `:accountId` path param. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account id (UUID) from the route path; throws HTTP 400 (`reason: 'account_required'`) if missing or not a UUID. */
export function accountIdParam(ctx: ServerKitContext): string {
    const accountId = (ctx.params.accountId ?? '').trim();
    if (!UUID_RE.test(accountId)) throw new HttpError(400).withDetails({ reason: 'account_required' });
    return accountId;
}

/** Rethrow iCloud client failures as HTTP errors; pass everything else through. */
export async function withICloudErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        const mapped = mapICloudError(error);
        if (mapped) throw mapped;
        throw error;
    }
}
