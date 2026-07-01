import { HttpError } from '@maroonedsoftware/errors';
import type { ServerKitContext } from '@maroonedsoftware/koa';
import { mapICloudError } from './error.mapping.js';

/** The Apple ID from the route path (koa-router already URL-decodes it), trimmed; throws HTTP 400 (`reason: 'account_required'`) if shorter than 3 characters. */
export function accountParam(ctx: ServerKitContext): string {
    const account = (ctx.params.account ?? '').trim();
    if (account.length < 3) throw new HttpError(400).withDetails({ reason: 'account_required' });
    return account;
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
