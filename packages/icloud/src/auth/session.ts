import { CLIENT_BUILD_NUMBER, CLIENT_MASTERING_NUMBER, SETUP_ENDPOINT, serviceBaseHeaders } from '../constants.js';
import { AuthenticationError } from '../errors.js';
import type { HttpClient } from '../http/client.js';
import type { DsInfo, WebservicesMap } from '../types.js';

export interface SessionResult {
    dsInfo: DsInfo;
    webservices: WebservicesMap;
}

export interface SessionParams {
    sessionToken: string;
    trustToken?: string;
    accountCountry?: string;
    clientId: string;
}

/**
 * Establish the iCloud session via `accountLogin`, returning the account's
 * `dsInfo` and the `webservices` endpoint map. The webservices URLs (e.g.
 * `https://p01-ckdatabasews.icloud.com:443`) are how every downstream service
 * client finds its base URL.
 */
export async function establishSession(http: HttpClient, params: SessionParams): Promise<SessionResult> {
    const query = new URLSearchParams({
        clientBuildNumber: CLIENT_BUILD_NUMBER,
        clientMasteringNumber: CLIENT_MASTERING_NUMBER,
        clientId: params.clientId,
    });

    const res = await http.send<{ dsInfo?: DsInfo; webservices?: WebservicesMap }>(`${SETUP_ENDPOINT}/accountLogin?${query.toString()}`, {
        method: 'POST',
        headers: { ...serviceBaseHeaders(), 'Content-Type': 'application/json' },
        json: {
            dsWebAuthToken: params.sessionToken,
            trustToken: params.trustToken ?? '',
            extended_login: true,
            accountCountryCode: params.accountCountry ?? '',
        },
    });

    if (res.status !== 200 || !res.data?.dsInfo || !res.data?.webservices) {
        throw new AuthenticationError('Failed to establish iCloud session', res.status, res.text);
    }
    return { dsInfo: res.data.dsInfo, webservices: res.data.webservices };
}

/**
 * Query the account's web-access / PCS state. Stubbed for a later iteration:
 * Advanced Data Protection accounts must grant PCS consent before some
 * services become reachable. Returns the raw response payload for now.
 */
export async function requestWebAccessState(http: HttpClient): Promise<{ isDeviceConsentedForPCS?: boolean; isICDRSDisabled?: boolean }> {
    const res = await http.send<{ isDeviceConsentedForPCS?: boolean; isICDRSDisabled?: boolean }>(`${SETUP_ENDPOINT}/requestWebAccessState`, {
        method: 'POST',
        headers: { ...serviceBaseHeaders(), 'Content-Type': 'application/json' },
        json: {},
    });
    return res.data ?? {};
}
