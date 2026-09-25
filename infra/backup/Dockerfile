# Nightly database backup — the image .github/workflows/backup.yml runs.
#
# ── Why an image at all ─────────────────────────────────────────────────────
#
# The workflow used to SSH in and run `node scripts/backup-database.js` on the
# VPS host. The host has neither node nor pg_dump — the app runs in Docker —
# so every run since the workflow was added failed at "node: command not
# found", and the free-plan Supabase project has no backups of its own. This
# image carries both tools, so the job no longer depends on what the host has.
#
# ── Why postgres:17 as the base ─────────────────────────────────────────────
#
# pg_dump refuses to dump a server newer than itself, and production is
# Postgres 17 (Supabase reports 17.6). Debian bookworm's own client is 15. The
# official postgres:17 image ships a matching pg_dump/pg_restore, and pulling
# it from Docker Hub is something every deploy on this VPS already does —
# unlike adding the PGDG apt repository, which would be one more network
# dependency on a host whose network is the least reliable part of a build.
#
# Bump the tag when the server's major version moves.

# Node plus the one runtime dependency the script needs (the R2 upload).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Pinned to the version in the backend's package-lock.json.
RUN npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund @aws-sdk/client-s3@3.1090.0

FROM postgres:17-bookworm
# The node binary alone: it needs only glibc and libstdc++, both already in
# this Debian bookworm base (ICU, which postgres links, depends on libstdc++).
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY scripts/backup-database.js scripts/backup-database.js

# Runs as root inside the container so it can write to the host directory
# mounted at BACKUP_DIR (created 0700 by the workflow). The postgres image's
# own entrypoint — the one that drops to the postgres user — is replaced, and
# no server is started: this container only runs pg_dump against a remote
# database and exits.
ENTRYPOINT ["node", "scripts/backup-database.js"]
