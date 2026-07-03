# iCloud Sync

Self-hosted service that signs into iCloud, mirrors your Photos library into
Postgres, and serves a small web UI to browse it and trigger syncs. Ships as a
single Docker container (API + background worker + UI in one process).

## Architecture

```
┌─ container (node:22) ──────────────────────────────┐
│  node dist/index.js  (startApiServer)               │
│   ├─ Koa API ............. /icloud/*  (JSON)        │
│   ├─ static SPA .......... /*  → apps/web/dist      │  history-API fallback
│   └─ pg-boss engine ...... producer + consumer+cron │  in-process worker
└──────────────────┬──────────────────────────────────┘
                   │ DATABASE_URL
            ┌──────▼──────┐
            │  Postgres   │  (compose service, or managed PG)
            └─────────────┘
```

- **`packages/icloud`** — the iCloud client library (SRP login, 2FA/trust,
  Photos over CloudKit, session persistence).
- **`apps/api`** — Koa API, the photo-sync job/worker, the encrypted session
  store, and the photo archive. `startApiServer` runs the API, the in-process
  sync worker, and serves the built SPA on one port.

### What gets backed up

Each sync mirrors photo **metadata** into Postgres and, for a filesystem
destination, downloads the **original bytes** of every asset into the photo
archive (a `@maroonedsoftware/storage` backend — local disk by default at
`ICLOUD_PHOTOS_DIR`, or S3/GCS). Both steps are idempotent: an asset's bytes are
re-fetched only when its checksum changes, so re-runs resume rather than redo.
The download proxy serves the archived copy when present and falls back to a live
iCloud fetch otherwise.

**Where photos go** is one setting — a *destination* — edited in the UI. Rather
than exposing raw folder/filename knobs, you pick an intent:

| Destination | What it does |
|---|---|
| **Filesystem → Immich-ready** (default preset) | Flat archive, original filenames, plus an XMP sidecar (`<file>.xmp`) per favorite/album photo carrying its favorite rating and album membership. Optimized for an Immich **external library** mounted read-only over the archive — Immich builds the timeline from each file's own EXIF, so folders are left flat on purpose. |
| **Filesystem → Browsable archive** | A `YYYY/YYYY-MM` date tree with original filenames, for browsing the raw files yourself. |
| **Filesystem → Custom** | The advanced escape hatch: raw `photos_layout` (`flat` \| `date` \| `album`) × `photos_naming` (`clean` \| `datetime` \| `hash`) knobs. Pre-existing installs land here so their configured layout/naming are honored verbatim. |
| **Immich (API upload)** | Uploads each asset straight into an Immich server via its API (`baseUrl` + `apiKey`). Immich owns storage — it dedupes by checksum, so re-syncs are cheap — and iCloud albums/favorites are reconciled as Immich albums/favorites (both toggleable). No layout/naming applies. |

Under the **Custom** filesystem preset, `photos_layout` / `photos_naming` are the
**global defaults** and each account can **override** either from its dashboard
(or `PATCH /icloud/accounts/:accountId/settings`); an unset override inherits the
default, resolving most-specific first (per-run payload override → account
override → global default). The other presets and the Immich destination dictate
the mechanics, so per-account layout/naming overrides don't apply there.

For the filesystem archive, files land directly in their layout folder (no
per-photo id sub-folder) so it stays browsable, and all three naming schemes are
collision-safe (the `~<hash>` suffix is derived from the photo's stable record id,
so re-syncs stay idempotent). Album resolution (for the `album` layout, XMP
sidecars, or Immich album recreation) pages each iCloud album, first album wins,
and degrades to `Unsorted`/no-album rather than failing the backup.
- **`apps/web`** — React + Vite SPA: sign-in (password + device/SMS 2FA), a
  stats dashboard, recent backups, and a settings panel (destination, schedule).

### Configuration model

Runtime, user-facing settings — the **account**, **photo layout**, **file
naming**, and **sync schedule** — live in the database (global defaults in
`app_settings`, per-account layout/naming overrides on `icloud_accounts`) and are
edited in the web UI
(or `PATCH /icloud/settings`); changing the schedule reschedules the worker
immediately. Only secrets and infra that must exist before the database is
reachable stay in the environment (see the table below).

### HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/icloud/status` | Active account (or `null`) + whether a session is loaded |
| `POST` | `/icloud/login` `{accountName, password}` | Begin auth → `authenticated` \| `mfaRequired`; persists the account |
| `POST` | `/icloud/2fa` `{code}` | Complete 2FA with a trusted-device code |
| `GET` | `/icloud/2fa/options` | Trusted-device count + SMS-capable numbers |
| `POST` | `/icloud/2fa/phone` `{phoneId}` | Send an SMS code |
| `POST` | `/icloud/2fa/phone/verify` `{phoneId, code}` | Complete 2FA via SMS |
| `POST` | `/icloud/logout` | Forget the persisted session |
| `GET` | `/icloud/photos` | Page the synced library (`limit`, `offset`, `favorite`, `includeHidden`, `includeDeleted`, `order`) |
| `GET` | `/icloud/photos/:recordName` | One synced asset |
| `GET` | `/icloud/photos/:recordName/download?resolution=` | Stream a rendition's bytes |
| `POST` | `/icloud/sync` | Enqueue an on-demand sync |

## Run with Docker

```sh
cp .env.example .env          # set ICLOUD_ENCRYPTION_SECRET (Apple ID is entered in the UI)
docker compose up --build     # UI + API on http://localhost:8930
```

Migrations run automatically on start (dbmate). The encrypted session is stored
in Postgres, so it survives restarts with no session volume. Open the UI, enter
your Apple ID + password and complete 2FA (first time only); the account is
persisted. The worker then syncs on the configured schedule (default every 6h) —
adjust it in **Settings**, or click **Sync now**.

### Environment variables

Secrets + infra only; everything user-facing is a DB setting (see above).

| Env | Required | Notes |
|---|---|---|
| `ICLOUD_ENCRYPTION_SECRET` | yes | Derives the AES key for the at-rest session; changing it forces re-login |
| `DATABASE_URL` | yes | Postgres connection string (also holds the encrypted session + settings) |
| `ICLOUD_PHOTOS_DIR` | no | Where backed-up photo files are written (default `~/.icloudsync/photos`; the container uses `/data/photos`) |
| `WEB_ROOT` | no | Built SPA dir to serve; unset = API only (the image sets it) |
| `PORT` | no | Listen port (image default `8930`; the app falls back to `3000` for local dev) |
| `PUID` / `PGID` | no | User/group that should own written photo files; the container chowns the archive to these and drops privileges (default `99` / `100`, Unraid's `nobody:users`) |
| `UMASK` | no | Permission mask for newly written photo files (default `022`) |

The container also serves `GET /health` — a DB-backed readiness probe (`200`
when Postgres answers, `503` otherwise) wired to the image's Docker `HEALTHCHECK`.

Database-backed settings (UI / `PATCH /icloud/settings`): `photos_destination`
(a filesystem preset or Immich config), `photos_layout` (`flat` \| `date` \|
`album`) and `photos_naming` for the filesystem `custom` preset, and `sync_cron`.
Each account is a row
in `icloud_accounts` keyed by an auto-generated UUID (the Apple ID is a unique
attribute); its encrypted session lives on that row (the `session` column) and
the Argon2id salt in `app_settings`. Only the photo bytes use a volume, so a
deployment needs just `DATABASE_URL` + `ICLOUD_ENCRYPTION_SECRET`.

## Run on Unraid

Unraid runs one container per template and does not orchestrate the bundled
`docker-compose.yml`, so **Postgres is a prerequisite you provide** — this image
does not embed a database. Set it up once before installing iCloud Sync:

1. **Add a Postgres container.** From **Apps** (Community Applications) install a
   PostgreSQL template (e.g. the official `postgres` image, or `binhex-postgresql`).
   Give it its own appdata volume (e.g. `/mnt/user/appdata/postgresql`) so the
   database survives updates. Postgres 14+ is fine; the app is tested on 16.
2. **Create the database.** Set a `POSTGRES_PASSWORD`, and either set
   `POSTGRES_DB=icloudsync` on the Postgres container or create the database
   manually. A dedicated role is optional — the `postgres` superuser works.
3. **Install iCloud Sync.** Add the container from the template at
   [`docker/unraid-template.xml`](docker/unraid-template.xml) (Docker tab → Add
   Container → Template, or add the raw URL as a private template repo). It pulls
   the prebuilt image `ghcr.io/maroonedsoftware/icloudsync:latest` and exposes
   these fields:
   - `DATABASE_URL` → point at the Postgres container. Use the Unraid host LAN IP
     (or the container name if both are on the same **custom** Docker network),
     not `localhost` — `localhost` resolves to iCloud Sync's own container. Example:
     `postgres://postgres:yourpassword@192.168.1.10:5432/icloudsync?sslmode=disable`
   - `ICLOUD_ENCRYPTION_SECRET` → a long random string (`openssl rand -hex 32`).
   - **Photos** path (container `/data/photos`) → a share, e.g.
     `/mnt/user/photos/icloud`. This is the only persistent app volume.
   - `PUID` / `PGID` / `UMASK` (advanced) → default `99` / `100` / `022`
     (Unraid's `nobody:users`). The entrypoint chowns the photos path to these
     and drops privileges, so backed-up files land with the ownership you expect.

Migrations run automatically on first start (dbmate), creating all tables in the
`icloudsync` database. The container reports a Docker `HEALTHCHECK` (a DB-backed
`GET /health`), so Unraid shows a real health dot. Then open the WebUI on the
host port you mapped (default `8930`), sign in with your Apple ID, and complete
2FA once. No `sslmode=disable`
is needed if your Postgres container enforces TLS — drop it and set
`sslmode=require` instead.

> The default `docker-compose.yml` in this repo bundles Postgres for a one-command
> `docker compose up` on a workstation. On Unraid, use a separate Postgres
> container as above instead of that compose file.

## Development

```sh
pnpm install
cp apps/api/.env.example apps/api/.env   # set ICLOUD_ENCRYPTION_SECRET (Apple ID is entered in the UI)
pnpm build:data            # run Postgres migrations + regenerate Kysely types
pnpm dev                   # turbo: API on :3000, Vite UI on :5173 (proxies /icloud)
pnpm test                  # all packages
```

`pnpm dev` auto-loads `apps/api/.env` (via `node --env-file-if-exists`).
`ICLOUD_ENCRYPTION_SECRET` and `DATABASE_URL` are required — the API exits at
boot if they're unset. The account, photo layout, and sync schedule are set in
the UI (stored in the DB). Requires Node ≥ 22, pnpm, and a local Postgres
(`postgres://postgres:postgres@localhost:5432/icloudsync`).
