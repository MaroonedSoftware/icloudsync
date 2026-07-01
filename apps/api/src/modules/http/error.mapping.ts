import { HttpError } from '@maroonedsoftware/errors';
import { AuthenticationError, ICloudError, InvalidSecurityCodeError, MfaRequiredError, PcsRequiredError } from '@icloudsync/icloud';

/**
 * Translate an error from the iCloud client into an {@link HttpError} the
 * `@maroonedsoftware/koa` error middleware can serialise. Returns `undefined`
 * for anything that isn't an iCloud error so the caller can rethrow it and let
 * the middleware render a generic 500.
 *
 * The `reason` in `details` is a stable, machine-readable discriminator clients
 * can branch on (e.g. show a 2FA prompt on `mfa_required`).
 */
export function mapICloudError(error: unknown): HttpError | undefined {
    if (error instanceof InvalidSecurityCodeError) {
        return new HttpError(401).withDetails({ reason: 'invalid_security_code' }).withCause(error);
    }
    if (error instanceof MfaRequiredError) {
        return new HttpError(401).withDetails({ reason: 'mfa_required' }).withCause(error);
    }
    if (error instanceof AuthenticationError) {
        return new HttpError(401).withDetails({ reason: 'authentication_failed' }).withCause(error);
    }
    if (error instanceof PcsRequiredError) {
        return new HttpError(409).withDetails({ reason: 'pcs_consent_required' }).withCause(error);
    }
    if (error instanceof ICloudError) {
        // An unclassified upstream failure (bad gateway from Apple's side).
        return new HttpError(502).withDetails({ reason: 'icloud_upstream_error', upstreamStatus: error.status }).withCause(error);
    }
    return undefined;
}
