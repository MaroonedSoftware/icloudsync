/** Base class for every error raised by this package. */
export class ICloudError extends Error {
    constructor(
        message: string,
        /** HTTP status that triggered the error, when applicable. */
        readonly status?: number,
        /** Raw response body, for diagnostics. */
        readonly body?: string,
    ) {
        super(message);
        this.name = new.target.name;
    }
}

/** Sign-in failed (bad credentials, malformed SRP exchange, etc.). */
export class AuthenticationError extends ICloudError {}

/** Two-factor authentication is required; submit a security code to continue. */
export class MfaRequiredError extends ICloudError {}

/** The submitted 2FA security code was rejected. */
export class InvalidSecurityCodeError extends ICloudError {}

/**
 * The account has Advanced Data Protection / iCloud Data Recovery Service
 * enabled and requires a PCS (Private Cloud Sync) consent grant before the
 * requested service is reachable.
 */
export class PcsRequiredError extends ICloudError {}

/**
 * iCloud returned HTTP 429 (Too Many Requests) and the request kept being
 * throttled after the client exhausted its automatic retries. Callers can use
 * {@link retryAfterMs} to back off before trying the operation again.
 */
export class RateLimitError extends ICloudError {
    constructor(
        message: string,
        status?: number,
        body?: string,
        /** How long the server asked us to wait (from `Retry-After`), in ms, when known. */
        readonly retryAfterMs?: number,
    ) {
        super(message, status, body);
    }
}
