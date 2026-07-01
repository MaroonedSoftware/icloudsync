#!/bin/sh
# Container entrypoint. Runs as root to (1) apply pending DB migrations and
# (2) normalise ownership of the photo archive, then drops to an unprivileged
# user (via gosu) to exec the app. Runs from WORKDIR /app/api, where
# data/migrations was copied.
set -e

if [ -z "$DATABASE_URL" ]; then
    echo "FATAL: DATABASE_URL is not set" >&2
    exit 1
fi

echo "Running database migrations…"
dbmate --url "$DATABASE_URL" --migrations-dir ./data/migrations --no-dump-schema up

# Unraid convention: files on the array are owned by nobody:users (99:100).
# PUID/PGID let the operator match the host account that should own the
# backed-up photos; UMASK controls their permission bits. The defaults suit
# Unraid and are harmless elsewhere (a Docker named volume is simply chowned to
# 99:100 on first boot).
PUID="${PUID:-99}"
PGID="${PGID:-100}"
umask "${UMASK:-022}"

PHOTOS_DIR="${ICLOUD_PHOTOS_DIR:-/data/photos}"
mkdir -p "$PHOTOS_DIR"
# Best-effort: a read-only or externally-managed mount shouldn't block startup.
chown -R "$PUID:$PGID" "$PHOTOS_DIR" 2>/dev/null ||
    echo "WARN: could not chown $PHOTOS_DIR to $PUID:$PGID (continuing)" >&2

echo "Starting iCloud Sync as ${PUID}:${PGID}…"
exec gosu "$PUID:$PGID" "$@"
