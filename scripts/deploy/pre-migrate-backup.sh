#!/usr/bin/env bash
# Take a verified database dump immediately before a production migration.
#
# ── Why this exists ─────────────────────────────────────────────────────────
#
# deploy.yml runs `npm run migrate` on every merge to main. The only other
# dump is the nightly job, so a deploy at 15:00 could apply a destructive
# migration with a restore point from 02:30 — or from none at all if that run
# failed. rules require a verified fresh backup before a production schema
# change; this is that backup, and it fails the deploy if it cannot be taken.
#
# ── Why it reuses the nightly image ────────────────────────────────────────
#
# infra/backup/Dockerfile already carries node and a pg_dump matching the
# server's major version, and scripts/backup-database.js already verifies the
# dump with pg_restore -l before reporting success. Building a second path
# would be a second thing to keep correct.
#
# ── What it deliberately does not do ───────────────────────────────────────
#
# Upload to R2, and update platform_backup_status. This is a local restore
# point for one deploy, not the daily off-site backup; the nightly job owns
# that row, and BACKUP_SKIP_STATUS keeps this run from overwriting it.
#
# Usage (the deploy workflow calls it as a single line):
#   bash scripts/deploy/pre-migrate-backup.sh /opt/myptstudio
#
# Exit code is non-zero on any failure, and the caller runs with `set -e`.

set -euo pipefail

ROOT="${1:-/opt/myptstudio}"
cd "$ROOT"

# Box-level knobs (BACKUP_DIR, BACKUP_RETAIN_DAYS) may live in .env.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# The credentials come from the running API container, for the same reason the
# nightly job reads them there: that string is, by definition, one that works
# right now, and it cannot drift from the app's.
CID="$(docker compose ps -q backend)"
if [ -z "$CID" ]; then
  echo "pre-migrate backup: the backend container is not running, so there is no connection string to copy." >&2
  exit 1
fi

ENV_FILE="$(mktemp)"
chmod 600 "$ENV_FILE"
trap 'rm -f "$ENV_FILE"' EXIT
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CID" \
  | grep -E '^(DATABASE_URL|ADMIN_DATABASE_URL)=' > "$ENV_FILE" || true
if ! grep -qE '^(DATABASE_URL|ADMIN_DATABASE_URL)=' "$ENV_FILE"; then
  echo "pre-migrate backup: the backend container has no DATABASE_URL either." >&2
  exit 1
fi

# A dump inside a working tree is one `git add` away from being published;
# scripts/backup-database.js refuses that, and so does this default.
BACKUP_HOST_DIR="${BACKUP_DIR:-/var/backups/619}"
install -d -m 700 "$BACKUP_HOST_DIR"

echo "pre-migrate backup: building the backup image"
docker build --quiet -t myptstudio-backup -f 619-erp-backend/infra/backup/Dockerfile 619-erp-backend

echo "pre-migrate backup: dumping into $BACKUP_HOST_DIR"
docker run --rm \
  --env-file "$ENV_FILE" \
  -e BACKUP_DIR=/backups \
  -e BACKUP_SKIP_STATUS=1 \
  -e BACKUP_RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}" \
  -v "$BACKUP_HOST_DIR:/backups" \
  myptstudio-backup

echo "pre-migrate backup: verified restore point written to $BACKUP_HOST_DIR. Safe to migrate."
