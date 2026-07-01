# @icloudsync/icloud

Framework-agnostic TypeScript client for Apple's private iCloud web APIs. This
first iteration is the **authentication foundation** that future service clients
(Photos, Drive, Find My) build on:

- **SRP-6a login** against `idmsa.apple.com` (hand-rolled with `node:crypto` —
  RFC 5054 2048-bit group, SHA-256, PBKDF2 password derivation).
- **2FA + trust token** handling, so subsequent logins skip the security-code
  prompt while the trust token is valid.
- **iCloud session establishment** (`accountLogin`) and **webservices
  discovery** (the `ckdatabasews` / `drivews` / `findme` / … endpoint map).
- **Pluggable persistence** via a tiny `Storage` interface (filesystem default;
  in-memory for tests).

It has **no runtime dependencies** — it relies on Node ≥ 22 globals (`fetch`,
`crypto`, `fs`).

## Usage

```ts
import { ICloudClient } from '@icloudsync/icloud';

const client = new ICloudClient({ accountName: 'me@icloud.com' });

const result = await client.login(process.env.APPLE_PASSWORD!);
if (result.state === 'mfaRequired') {
    await client.submitSecurityCode('123456'); // code from a trusted device
}

console.log(client.dsid);
console.log(client.serviceUrl('ckdatabasews')); // Photos/CloudKit base URL

// Authenticated request against a discovered service (cookies + dsid injected):
const res = await client.request(client.serviceUrl('drivews')!, '/retrieveAppLibraries', { method: 'POST', json: {} });
```

On the second run the persisted session is rehydrated and, if the trust token is
still valid, `login()` resolves straight to `{ state: 'authenticated' }` without
a 2FA prompt.

### Photos

Once authenticated, `client.photos()` returns a CloudKit-backed Photos service:

```ts
const photos = client.photos(); // PrimarySync zone by default

const total = await photos.getCount();
const albums = await photos.getAlbums();

// Lazily page the whole library (asset+master records are paired for you):
for await (const asset of photos.list({ direction: 'DESCENDING' })) {
    console.log(asset.filename, asset.assetDate, Object.keys(asset.resources));
    const bytes = await photos.download(asset, 'resOriginalRes'); // or resJPEGFullRes, …
}

// Smart albums:
const favourites = await photos.listAll({ smartAlbum: 'FAVORITE' });
```

Each `PhotoAsset` exposes decoded `filename`, capture/added dates, favourite/hidden/
deleted flags, and a `resources` map of downloadable renditions (`resOriginalRes`,
`resJPEGFullRes`, `resJPEGMedRes`, …) keyed by CloudKit field name.

### Persistence

`ICloudClient` defaults to `FileStorage` (`~/.icloudsync`, `0600` files). The
`Storage` interface is a string-keyed byte store, so `apps/api` supplies an
adapter backed by `@maroonedsoftware/storage` (filesystem / S3 / GCS) that wraps
the blob with `@maroonedsoftware/encryption` for encryption at rest:

```ts
const client = new ICloudClient({ accountName, storage: myServerKitAdapter });
```

## Live smoke test

`scripts/login.ts` performs a real end-to-end login against your account:

```sh
APPLE_ID=me@icloud.com APPLE_PASSWORD='…' pnpm --filter @icloudsync/icloud login:live
```

It prompts for the 2FA code on stdin and prints the resolved `dsid` and the
discovered service URLs. It is intentionally gated behind env vars so it never
runs in CI.

## Caveats

The widget key, user-agent, and client build numbers in `src/constants.ts` are
unofficial values mirroring Apple's web client; they may need refreshing if
Apple rotates them. This library talks to an undocumented, private API for
interoperability with an account you own.
