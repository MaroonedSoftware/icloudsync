import { HttpError } from '@maroonedsoftware/errors';
import {
    AuthenticationError,
    ICloudError,
    InvalidSecurityCodeError,
    MfaRequiredError,
    PcsRequiredError,
} from '@icloudsync/icloud';
import { describe, expect, it } from 'vitest';
import { mapICloudError } from '../../src/modules/http/error.mapping.js';

describe('mapICloudError', () => {
    it('maps InvalidSecurityCodeError to 401 invalid_security_code', () => {
        const error = new InvalidSecurityCodeError('bad code');
        const mapped = mapICloudError(error);
        expect(mapped).toBeInstanceOf(HttpError);
        expect(mapped?.statusCode).toBe(401);
        expect(mapped?.details?.reason).toBe('invalid_security_code');
        expect(mapped?.cause).toBe(error);
    });

    it('maps MfaRequiredError to 401 mfa_required', () => {
        const error = new MfaRequiredError('2fa needed');
        const mapped = mapICloudError(error);
        expect(mapped?.statusCode).toBe(401);
        expect(mapped?.details?.reason).toBe('mfa_required');
        expect(mapped?.cause).toBe(error);
    });

    it('maps AuthenticationError to 401 authentication_failed', () => {
        const error = new AuthenticationError('bad credentials');
        const mapped = mapICloudError(error);
        expect(mapped?.statusCode).toBe(401);
        expect(mapped?.details?.reason).toBe('authentication_failed');
        expect(mapped?.cause).toBe(error);
    });

    it('maps PcsRequiredError to 409 pcs_consent_required', () => {
        const error = new PcsRequiredError('consent needed');
        const mapped = mapICloudError(error);
        expect(mapped?.statusCode).toBe(409);
        expect(mapped?.details?.reason).toBe('pcs_consent_required');
        expect(mapped?.cause).toBe(error);
    });

    it('maps a generic ICloudError to 502 icloud_upstream_error and carries upstreamStatus', () => {
        const error = new ICloudError('gateway down', 503, 'body');
        const mapped = mapICloudError(error);
        expect(mapped?.statusCode).toBe(502);
        expect(mapped?.details?.reason).toBe('icloud_upstream_error');
        expect(mapped?.details?.upstreamStatus).toBe(503);
        expect(mapped?.cause).toBe(error);
    });

    it('leaves upstreamStatus undefined when the ICloudError has no status', () => {
        const error = new ICloudError('opaque failure');
        const mapped = mapICloudError(error);
        expect(mapped?.statusCode).toBe(502);
        expect(mapped?.details?.upstreamStatus).toBeUndefined();
    });

    it('prefers the most specific subclass over the ICloudError base branch', () => {
        // AuthenticationError is an ICloudError; it must not fall through to 502.
        const mapped = mapICloudError(new AuthenticationError('nope'));
        expect(mapped?.statusCode).toBe(401);
        expect(mapped?.details?.reason).toBe('authentication_failed');
    });

    it('returns undefined for a plain Error so the caller can rethrow', () => {
        expect(mapICloudError(new Error('boom'))).toBeUndefined();
    });

    it('returns undefined for non-error values', () => {
        expect(mapICloudError('a string')).toBeUndefined();
        expect(mapICloudError(undefined)).toBeUndefined();
        expect(mapICloudError(null)).toBeUndefined();
        expect(mapICloudError({ reason: 'not an error' })).toBeUndefined();
    });
});
