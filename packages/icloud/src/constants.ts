/**
 * Hardcoded values mirroring Apple's iCloud web client, as used by
 * `foxt/icloud.js` and `picklepete/pyicloud`. These are stable but
 * unofficial — they may need refreshing if Apple rotates them.
 */

/** GSA authentication base. */
export const AUTH_ENDPOINT = 'https://idmsa.apple.com/appleauth/auth';

/** iCloud setup/web-services base. */
export const SETUP_ENDPOINT = 'https://setup.icloud.com/setup/ws/1';

/** OAuth client id == widget key for the iCloud web client. */
export const CLIENT_ID = 'd39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d';

/** User-Agent presented to Apple's endpoints. */
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:103.0) Gecko/20100101 Firefox/103.0';

/** Client build identifiers sent as query params to `accountLogin`. */
export const CLIENT_BUILD_NUMBER = '2021Project52';
export const CLIENT_MASTERING_NUMBER = '2021B29';

/** Stringified device fingerprint for the `X-Apple-I-FD-Client-Info` header. */
export function fdClientInfo(): string {
    return JSON.stringify({ U: USER_AGENT, L: 'en-US', Z: 'GMT+00:00', V: '1.1', F: '' });
}

/** Common GSA auth headers (excludes the dynamic `scnt` / session-id values). */
export function authBaseHeaders(oauthState: string): Record<string, string> {
    return {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Origin: 'https://idmsa.apple.com',
        Referer: 'https://idmsa.apple.com/',
        'X-Apple-Widget-Key': CLIENT_ID,
        'X-Apple-OAuth-Client-Id': CLIENT_ID,
        'X-Apple-OAuth-Client-Type': 'firstPartyAuth',
        'X-Apple-OAuth-Redirect-URI': 'https://www.icloud.com',
        'X-Apple-OAuth-Require-Grant-Code': 'true',
        'X-Apple-OAuth-Response-Mode': 'web_message',
        'X-Apple-OAuth-Response-Type': 'code',
        'X-Apple-OAuth-State': oauthState,
        'X-Apple-I-FD-Client-Info': fdClientInfo(),
    };
}

/** Default headers for authenticated iCloud service / setup requests. */
export function serviceBaseHeaders(): Record<string, string> {
    return {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        Origin: 'https://www.icloud.com',
        Referer: 'https://www.icloud.com/',
    };
}
