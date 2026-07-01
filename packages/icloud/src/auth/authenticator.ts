import { AUTH_ENDPOINT, authBaseHeaders } from '../constants.js';
import { AuthenticationError, InvalidSecurityCodeError } from '../errors.js';
import type { HttpClient } from '../http/client.js';
import { SrpSession } from '../srp/client.srp.js';

const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const fromB64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'));

interface SignInInitResponse {
    salt: string;
    b: string;
    c: string;
    iteration: number;
    protocol: 's2k' | 's2k_fo';
}

/** A trusted phone number usable for SMS 2FA. */
export interface TrustedPhoneNumber {
    id: number;
    numberWithDialCode?: string;
    pushMode?: string;
}

/** The account's 2FA context, from `GET /appleauth/auth`. */
export interface AuthState {
    authType?: string;
    trustedDeviceCount?: number;
    noTrustedDevices?: boolean;
    /** Top-level trusted phone numbers (some accounts). */
    trustedPhoneNumbers?: TrustedPhoneNumber[];
    /** Nested phone-verification block (most hsa2 accounts). */
    phoneNumberVerification?: {
        trustedPhoneNumbers?: TrustedPhoneNumber[];
        authenticationType?: string;
    };
    securityCode?: { length?: number };
}

/** Trusted phone numbers from either the top-level or nested location. */
export function trustedPhoneNumbersOf(state: AuthState): TrustedPhoneNumber[] {
    return state.trustedPhoneNumbers ?? state.phoneNumberVerification?.trustedPhoneNumbers ?? [];
}

/** Result of a primary sign-in attempt. */
export interface SignInOutcome {
    /** True when Apple returned 409 and a 2FA security code is required. */
    mfaRequired: boolean;
    /** `dsWebAuthToken` for `accountLogin` (present on direct success). */
    sessionToken?: string;
    accountCountry?: string;
}

/**
 * Drives Apple's GSA sign-in: SRP `init` -> `complete`, the 2FA security-code
 * submission, and the trust-token exchange. Tracks the rolling `scnt` and
 * `X-Apple-ID-Session-Id` values that Apple requires to be echoed across steps.
 */
export class Authenticator {
    private scnt?: string;
    private sessionId?: string;

    constructor(
        private readonly http: HttpClient,
        private readonly accountName: string,
        private readonly oauthState: string,
        private readonly debug: boolean = false,
    ) {}

    private log(...args: unknown[]): void {
        if (this.debug) console.error('[icloud][debug]', ...args);
    }

    private headers(): Record<string, string> {
        const headers = authBaseHeaders(this.oauthState);
        if (this.scnt) headers['scnt'] = this.scnt;
        if (this.sessionId) headers['X-Apple-ID-Session-Id'] = this.sessionId;
        return headers;
    }

    private capture(headers: Headers): void {
        const scnt = headers.get('scnt');
        if (scnt) this.scnt = scnt;
        const sessionId = headers.get('X-Apple-ID-Session-Id');
        if (sessionId) this.sessionId = sessionId;
    }

    /** SRP `init` + `complete`. Returns `{ mfaRequired: true }` on a 409. */
    async signIn(password: string, trustTokens: string[]): Promise<SignInOutcome> {
        const srp = new SrpSession(this.accountName);

        const init = await this.http.send<SignInInitResponse>(`${AUTH_ENDPOINT}/signin/init`, {
            method: 'POST',
            headers: this.headers(),
            json: { a: toB64(srp.publicA), accountName: this.accountName, protocols: ['s2k', 's2k_fo'] },
        });
        this.capture(init.headers);
        if (init.status !== 200 || !init.data) {
            throw new AuthenticationError('SRP init failed', init.status, init.text);
        }

        const { salt, b, c, iteration, protocol } = init.data;
        this.log('signin/init ok', { protocol, iteration, saltLen: fromB64(salt).length, bLen: fromB64(b).length, scnt: Boolean(this.scnt), sessionId: Boolean(this.sessionId) });
        const proof = srp.computeProof(password, { salt: fromB64(salt), serverB: fromB64(b), iteration, protocol });
        this.log('proof computed', { m1Len: proof.m1.length, m2Len: proof.m2.length, aLen: srp.publicA.length });

        const complete = await this.http.send(`${AUTH_ENDPOINT}/signin/complete?isRememberMeEnabled=true`, {
            method: 'POST',
            headers: this.headers(),
            json: {
                accountName: this.accountName,
                c,
                m1: toB64(proof.m1),
                m2: toB64(proof.m2),
                rememberMe: true,
                trustTokens,
            },
        });
        this.capture(complete.headers);
        this.log('signin/complete', { status: complete.status, body: complete.status >= 400 ? complete.text : undefined });

        if (complete.status === 409) return { mfaRequired: true };
        if (complete.status === 200) {
            return {
                mfaRequired: false,
                sessionToken: complete.headers.get('X-Apple-Session-Token') ?? undefined,
                accountCountry: complete.headers.get('X-Apple-ID-Account-Country') ?? undefined,
            };
        }
        if (complete.status === 401) {
            throw new AuthenticationError('Invalid Apple ID or password', 401, complete.text);
        }
        throw new AuthenticationError(`Unexpected sign-in response (${complete.status})`, complete.status, complete.text);
    }

    /**
     * Fetch the 2FA context: how many trusted devices received a push code, and
     * the trusted phone numbers available for SMS. Used to decide whether the
     * user should read the code off a device or have an SMS sent.
     */
    async getAuthState(): Promise<AuthState> {
        const res = await this.http.send<AuthState>(AUTH_ENDPOINT, { method: 'GET', headers: this.headers() });
        this.capture(res.headers);
        const state = res.data ?? {};
        this.log('auth state', {
            status: res.status,
            trustedDeviceCount: state.trustedDeviceCount,
            phones: trustedPhoneNumbersOf(state).map(p => ({ id: p.id, number: p.numberWithDialCode })),
        });
        return state;
    }

    /**
     * Ask Apple to push a 6-digit security code to the account's trusted devices.
     *
     * This is the trusted-device analogue of {@link requestPhoneCode}. Apple does
     * **not** reliably auto-push the code on the sign-in 409 for HSA2 accounts, so
     * without this explicit `GET /verify/trusteddevice` the code never arrives on
     * any device. Safe to call again to resend.
     */
    async requestDeviceCode(): Promise<void> {
        const res = await this.http.send(`${AUTH_ENDPOINT}/verify/trusteddevice`, {
            method: 'GET',
            headers: this.headers(),
        });
        this.capture(res.headers);
        this.log('request device code', { status: res.status });
        // 200 = code pushed; 412 = no trusted device available for this account
        // (fall back to SMS). Anything else is unexpected.
        if (res.status === 412) {
            throw new AuthenticationError('No trusted device is available; use SMS instead', res.status, res.text);
        }
        if (res.status !== 200 && res.status !== 204) {
            throw new AuthenticationError('Failed to send trusted-device security code', res.status, res.text);
        }
    }

    /** Submit a trusted-device 2FA security code (expects 204). */
    async submitSecurityCode(code: string): Promise<void> {
        const res = await this.http.send(`${AUTH_ENDPOINT}/verify/trusteddevice/securitycode`, {
            method: 'POST',
            headers: this.headers(),
            json: { securityCode: { code } },
        });
        this.capture(res.headers);
        if (res.status !== 204 && res.status !== 200) {
            throw new InvalidSecurityCodeError('Invalid security code', res.status, res.text);
        }
    }

    /** Request an SMS security code be sent to a trusted phone number. */
    async requestPhoneCode(phoneId: number): Promise<void> {
        const res = await this.http.send(`${AUTH_ENDPOINT}/verify/phone`, {
            method: 'PUT',
            headers: this.headers(),
            json: { phoneNumber: { id: phoneId }, mode: 'sms' },
        });
        this.capture(res.headers);
        if (res.status !== 200) {
            throw new AuthenticationError('Failed to send SMS security code', res.status, res.text);
        }
    }

    /** Submit an SMS security code sent to a trusted phone number. */
    async submitPhoneCode(code: string, phoneId: number): Promise<void> {
        const res = await this.http.send(`${AUTH_ENDPOINT}/verify/phone/securitycode`, {
            method: 'POST',
            headers: this.headers(),
            json: { securityCode: { code }, phoneNumber: { id: phoneId }, mode: 'sms' },
        });
        this.capture(res.headers);
        if (res.status !== 200 && res.status !== 204) {
            throw new InvalidSecurityCodeError('Invalid security code', res.status, res.text);
        }
    }

    /** Exchange the verified session for a persistable trust token. */
    async trust(): Promise<{ trustToken?: string; sessionToken?: string }> {
        const res = await this.http.send(`${AUTH_ENDPOINT}/2sv/trust`, {
            method: 'GET',
            headers: this.headers(),
        });
        this.capture(res.headers);
        return {
            trustToken: res.headers.get('X-Apple-TwoSV-Trust-Token') ?? undefined,
            sessionToken: res.headers.get('X-Apple-Session-Token') ?? undefined,
        };
    }
}
