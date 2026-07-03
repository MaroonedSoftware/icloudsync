import { HttpError } from '@maroonedsoftware/errors';
import type { ServerKitContext } from '@maroonedsoftware/koa';
import { AuthenticationError, PcsRequiredError } from '@icloudsync/icloud';
import { describe, expect, it } from 'vitest';
import { accountIdParam, withICloudErrors } from '../../src/modules/http/route.helpers.js';

/** Build a minimal context carrying only the route params the helper reads. */
function contextWith(params: Record<string, string | undefined>): ServerKitContext {
    return { params } as unknown as ServerKitContext;
}

const UUID = '44444444-4444-4444-8444-444444444444';

describe('accountIdParam', () => {
    it('returns the account id (UUID) from the route params', () => {
        expect(accountIdParam(contextWith({ accountId: UUID }))).toBe(UUID);
    });

    it('trims surrounding whitespace around the UUID', () => {
        expect(accountIdParam(contextWith({ accountId: `  ${UUID}  ` }))).toBe(UUID);
    });

    it('throws HTTP 400 account_required when the param is missing', () => {
        try {
            accountIdParam(contextWith({}));
            expect.unreachable('expected accountIdParam to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(HttpError);
            expect((error as HttpError).statusCode).toBe(400);
            expect((error as HttpError).details?.reason).toBe('account_required');
        }
    });

    it('throws HTTP 400 when the param is not a UUID', () => {
        expect(() => accountIdParam(contextWith({ accountId: 'user@example.com' }))).toThrow(HttpError);
        expect(() => accountIdParam(contextWith({ accountId: 'abc' }))).toThrow(HttpError);
    });

    it('throws HTTP 400 when the param is only whitespace', () => {
        expect(() => accountIdParam(contextWith({ accountId: '   ' }))).toThrow(HttpError);
    });
});

describe('withICloudErrors', () => {
    it('returns the wrapped function result on success', async () => {
        await expect(withICloudErrors(async () => 42)).resolves.toBe(42);
    });

    it('translates a thrown iCloud error into the mapped HttpError', async () => {
        const cause = new AuthenticationError('bad credentials');
        await expect(
            withICloudErrors(async () => {
                throw cause;
            }),
        ).rejects.toMatchObject({ statusCode: 401, details: { reason: 'authentication_failed' } });
    });

    it('maps PcsRequiredError to a 409 HttpError', async () => {
        await expect(
            withICloudErrors(async () => {
                throw new PcsRequiredError('consent needed');
            }),
        ).rejects.toMatchObject({ statusCode: 409, details: { reason: 'pcs_consent_required' } });
    });

    it('rethrows the mapped HttpError as an HttpError instance', async () => {
        try {
            await withICloudErrors(async () => {
                throw new AuthenticationError('nope');
            });
            expect.unreachable('expected withICloudErrors to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(HttpError);
        }
    });

    it('passes non-iCloud errors through unchanged', async () => {
        const original = new Error('unrelated failure');
        await expect(
            withICloudErrors(async () => {
                throw original;
            }),
        ).rejects.toBe(original);
    });
});
