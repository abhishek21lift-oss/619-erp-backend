#!/usr/bin/env bash
#
# Ask the running container which commit it is serving, and record the deploy
# only if the answer matches what we just built.
#
# ── Why this is a file and not lines in deploy.yml ────────────────────────
#
# It started life as a `for` loop inside the workflow's DEPLOY_SCRIPT, and it
# never executed. The deploy log showed the container starting and the script
# exiting 1 forty-one milliseconds later, with none of the loop's output —
# not the error branch, not the 150 seconds of polling it should have taken.
# Run as an ordinary script the same block polls for the full 150s and reports
# correctly, so the block was right and the way it was being executed was not:
# the multi-line shell constructs were the first ones that DEPLOY_SCRIPT had
# ever contained, and everything up to them had been one command per line.
#
# Rather than guess at how the SSH action assembles those lines, the logic
# lives here, where it is one command to invoke, has ordinary shell semantics,
# and can be tested — which deploy.yml never could be.
set -eu

EXPECTED_SHA="${1:?usage: verify-serving.sh <expected-sha> [compose-dir] [service] [health-url] [marker-file]}"
COMPOSE_DIR="${2:-/opt/myptstudio}"
SERVICE="${3:-backend}"
HEALTH_URL="${4:-http://127.0.0.1:5000/api/health}"
MARKER="${5:-/opt/myptstudio/.backend-deployed-sha}"

ATTEMPTS="${VERIFY_ATTEMPTS:-30}"
INTERVAL="${VERIFY_INTERVAL:-5}"

# The sha the container reports, or empty if it is not answering yet.
#
# Whitespace-tolerant on purpose. The first version required exactly
# `"sha":"..."`, which matches what Express's res.json() emits today and
# nothing else — any future pretty-printing of the health payload would have
# turned this check into one that always failed, and a deploy gate that fails
# for a formatting change is a deploy gate people learn to bypass.
serving_sha() {
  local body
  body="$(curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
  printf '%s' "$body" \
    | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{7,40\}\)".*/\1/p' \
    | head -1
}

echo "verifying: expecting $EXPECTED_SHA at $HEALTH_URL"

SERVING=""
attempt=0
while [ "$attempt" -lt "$ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  SERVING="$(serving_sha)"
  if [ -n "$SERVING" ] && [ "$SERVING" = "$EXPECTED_SHA" ]; then
    break
  fi
  sleep "$INTERVAL"
done

if [ "$SERVING" != "$EXPECTED_SHA" ]; then
  echo "::error::deploy verification failed after ${attempt} attempts — expected ${EXPECTED_SHA}, container reports '${SERVING:-no answer}'"
  ( cd "$COMPOSE_DIR" && docker compose logs --tail 60 "$SERVICE" ) || true
  # The marker is NOT advanced. It keeps naming the last commit known to have
  # actually served traffic, which is what a rollback needs.
  rm -f "${MARKER}.new"
  exit 1
fi

echo "deploy verified: ${SERVICE} is serving ${SERVING} (after ${attempt} attempt(s))"
mv "${MARKER}.new" "$MARKER"
( cd "$COMPOSE_DIR" && docker image prune -f ) || true
