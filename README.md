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

Each sync mirrors photo **metadata** into Postgres and downloads the **original
bytes** of every asset into the photo archive (a `@maroonedsoftware/storage`
backend — local disk by default at `ICLOUD_PHOTOS_DIR`, or S3/GCS). Both steps
are idempotent: an asset's bytes are re-fetched only when its checksum changes,
so re-runs resume rather than redo. The download proxy serves the archived copy
when present and falls back to a live iCloud fetch otherwise.

**On-disk organization** has two independent settings, both edited in the UI:
which folders assets are filed under (`photos_layout`) and how each file is named
within its folder (`photos_naming`). Files land directly in their layout folder
(no per-photo id sub-folder), so the archive is browsable:

| `photos_layout` | Folder under `ICLOUD_PHOTOS_DIR` |
|---|---|
| `flat` (default) | `<account>/` |
| `date` | `<account>/YYYY/YYYY-MM/` (by capture date) |
| `album` | `<account>/<album>/` (photos in no album → `Unsorted/`) |

| `photos_naming` | Filename within the folder |
|---|---|
| `clean` (default) | `IMG_0001.HEIC` — original name; a `~<hash>` suffix is added only when a different photo already holds that name |
| `datetime` | `20240315-143022_IMG_0001.HEIC` — capture timestamp prefixed; sorts chronologically |
| `hash` | `IMG_0001~a1b2c3.HEIC` — a short per-photo id inserted before the extension; always unique |

`photos_layout` / `photos_naming` are the **global defaults**; each account can
**override** either one from its dashboard (or `PATCH /icloud/accounts/:accountId/settings`),
and an unset override inherits the default. The effective value for a sync
resolves most-specific first: a per-run payload override, else the account's
override, else the global default.

`date` is free (uses metadata already synced). `album` pages each iCloud album to
resolve membership (first album wins for a photo in several); if that lookup
fails it degrades to `Unsorted/` rather than failing the backup. All three naming
schemes are collision-safe, and the collision suffix is derived from the photo's
stable record id so re-syncs stay idempotent.
- **`apps/web`** — React + Vite SPA: sign-in (password + device/SMS 2FA), a
  stats dashboard, recent backups, and a settings panel (layout, naming, schedule).

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

Database-backed settings (UI / `PATCH /icloud/settings`): `photos_layout`
(`flat` \| `date` \| `album`), `photos_naming`, `sync_cron`. Each account is a row
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
