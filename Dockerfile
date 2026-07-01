# syntax=docker/dockerfile:1

# ── Base ───────────────────────────────────────────────────────────────────
# Pin Node and activate the repo's pinned pnpm via corepack.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ── Build ──────────────────────────────────────────────────────────────────
# Install the whole workspace (dev deps included) and build every package:
# packages/icloud (tsup), apps/web (Vite → static), apps/api (tsc → dist).
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build

# Produce a self-contained, production-only deployment of the API with its
# workspace deps (incl. the built @icloudsync/icloud) flattened into node_modules.
RUN pnpm --filter=@icloudsync/api deploy --prod /prod/api

# ── Runtime ────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Uncommon default port to avoid clashing with the many services that use 3000.
ENV PORT=8930
# Served SPA + config + migrations live under these paths in the image.
ENV WEB_ROOT=/app/web
# Default photo archive location; the entrypoint chowns this to PUID:PGID.
ENV ICLOUD_PHOTOS_DIR=/data/photos
WORKDIR /app/api

# gosu drops root → PUID:PGID in the entrypoint so backed-up files land with the
# host account's ownership (Unraid uses nobody:users = 99:100).
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

# dbmate (static Go binary) runs the migrations at container start. TARGETARCH
# is provided by buildx and matches dbmate's release asset names (amd64/arm64).
ARG TARGETARCH=amd64
ADD https://github.com/amacneil/dbmate/releases/latest/download/dbmate-linux-${TARGETARCH} /usr/local/bin/dbmate
RUN chmod +x /usr/local/bin/dbmate

# The pruned API (dist, config/app.yaml, data/migrations, node_modules)…
COPY --from=build /prod/api ./
# …and the built web bundle the API serves from WEB_ROOT.
COPY --from=build /repo/apps/web/dist /app/web
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8930

# Orchestrator health signal (Docker/Unraid): hit the app's DB-backed /health.
# node:22 ships global fetch, so no curl is needed in the slim image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8930)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "dist/index.js"]
