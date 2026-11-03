#!/usr/bin/env bash
# Stand up the Phase 4/5 production-shaped database.
#
# Reuses rls-proof-setup.sh for the real schema, the real migrations and the
# app_tenant role, then applies scripts/phase4-seed-shape.sql. The result is the
# SYNTHETIC fixture, not production: it reproduces the shapes the ownership
# rules must survive (history, late entries, missing owners, conflicts, stale
# records) so the Phase 4 gate and the Phase 5 reconciliation report always
# have a database instead of skipping.
#
#   ./scripts/phase4-shape-setup.sh
#   RLS_PG_PORT=5433 ./scripts/phase4-shape-setup.sh
#
# Then:
#   export PHASE4_SHAPE_DATABASE_URL='postgres://postgres@localhost:55432/phase4_shape?sslmode=disable'
#   npx jest src/__tests__/productionShape.phase4.realDb.integration.test.js --runInBand

set -euo pipefail

PORT="${RLS_PG_PORT:-55432}"
DB="${RLS_PG_DATABASE:-phase4_shape}"
HOST="${RLS_PG_HOST:-localhost}"
SUPER="${RLS_PG_SUPERUSER:-postgres}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="postgres://${SUPER}@${HOST}:${PORT}"

case "$BASE" in
  *supabase*|*pooler*|*amazonaws*|*rds*)
    echo "Refusing to run: this looks like a real environment." >&2; exit 1 ;;
esac

RLS_PG_DATABASE="$DB" "$HERE/rls-proof-setup.sh"

echo "==> Seeding the Phase 4/5 production-shaped fixture"
psql "$BASE/$DB" -v ON_ERROR_STOP=1 -q -f "$HERE/phase4-seed-shape.sql"

cat <<EOF

Ready.

  export PHASE4_SHAPE_DATABASE_URL='$BASE/$DB?sslmode=disable'
  npx jest src/__tests__/productionShape.phase4.realDb.integration.test.js --runInBand
EOF
