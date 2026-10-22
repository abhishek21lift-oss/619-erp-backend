# Client Assistant cutover and rollback

Current production runbook for the consolidated Client Assistant.

The assistant runs in the ERP backend at:

```
POST /api/ai/client-agent/chat/stream
```

There is no standalone AI container, `/ai/` nginx route, `AI_SERVICE_URL`
rewrite, service-attestation header, or service quota/usage bridge. The
historical `docs/AI-RELEASE-READINESS-PHASE-6.md` describes the retired
topology; do not follow its commands.

This document contains commands only. **Executing any of them is a production
change and requires explicit authorization.** It does not print `.env`
contents or secret values.

## Topology after cutover

```
browser
  -> nginx (myptstudio.com)
  -> frontend container :3000
  -> Next rewrite
  -> nginx (api.myptstudio.com)
  -> backend container :5000
```

Both nginx vhosts must have the `/api/ai/` location with
`proxy_read_timeout 300s` and `proxy_buffering off`. The frontend block covers
the browser hop; the API block covers the Next rewrite hop.

## 1. Preflight (read-only)

Run as a user that can use Docker and `sudo` for nginx. **Keep all blocks in
the same shell session**: they reuse `COMPOSE_FILE`, `BACKEND_SVC`,
`FRONTEND_SVC` and `STAMP`. Do not use `cat` on `.env`; every check below
prints a status or a variable name, not a value.

```bash
set -eu
cd /opt/myptstudio

COMPOSE_FILE="$(for f in docker-compose.yml compose.yaml; do
  [ -f "$f" ] && printf '%s\n' "$f" && break
done)"
test -n "${COMPOSE_FILE:-}"
docker compose -f "$COMPOSE_FILE" config -q

SERVICES="$(docker compose -f "$COMPOSE_FILE" config --services)"
printf '%s\n' "$SERVICES"
BACKEND_SVC="$(printf '%s\n' "$SERVICES" | grep -m1 -E '^(backend|api)$' || true)"
FRONTEND_SVC="$(printf '%s\n' "$SERVICES" | grep -m1 -E '^frontend$' || true)"
AI_SVC="$(printf '%s\n' "$SERVICES" | grep -m1 -E '^(ai|mps-ai|mps_ai)$' || true)"
test -n "${BACKEND_SVC:-}"
test -n "${FRONTEND_SVC:-}"
printf 'backend=%s frontend=%s retired_ai=%s\n' "$BACKEND_SVC" "$FRONTEND_SVC" "${AI_SVC:-none}"

# If either test fails, use the service list printed above and set the two
# names manually in this shell before continuing, for example:
#   BACKEND_SVC=api FRONTEND_SVC=web
docker compose -f "$COMPOSE_FILE" ps
sudo nginx -t
```

Check for stale configuration by count only:

```bash
cd /opt/myptstudio
grep -c '^AI_SERVICE_URL=' .env || true
grep -c '^SERVICE_AUTH_SECRET=' .env || true
grep -c '^AI_ALLOWED_ORIGINS=' .env || true
grep -c '^ALLOWED_ORIGINS=' .env || true
grep -c '^ERP_BACKEND_URL=' .env || true
grep -c '^AI_QUOTA_MODE=' .env || true
sudo nginx -T 2>/dev/null | grep -nE '^[[:space:]]*location[[:space:]]+/ai/' || true
sudo nginx -T 2>/dev/null | grep -nE '^[[:space:]]*location[[:space:]]+/api/ai/' || true
```

Expected after cutover: every stale key count is `0`; no `location /ai/`; two
`location /api/ai/` blocks, one in each vhost.

If the retired AI service exists, check its failure bias without printing
secrets. `enforce` means the old panel will fail closed as soon as the backend
bridge is removed; plan a maintenance window or switch the old service to
`monitor` for the cutover.

```bash
if [ -n "${AI_SVC:-}" ]; then
  printf 'retired AI service %s: AI_QUOTA_MODE=' "$AI_SVC"
  docker compose -f "$COMPOSE_FILE" exec -T "$AI_SVC" printenv AI_QUOTA_MODE || echo UNSET
fi
```

### Snapshot before changing anything

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
cd /opt/myptstudio
sudo cp -a "$COMPOSE_FILE" "$COMPOSE_FILE.bak.$STAMP"
sudo cp -a .env ".env.bak.$STAMP"
sudo cp -a /etc/nginx "/etc/nginx.bak.$STAMP"
for marker in .backend-deployed-sha .frontend-deployed-sha; do
  if [ -f "$marker" ]; then
    sudo cp -a "$marker" "$marker.bak.$STAMP"
    printf '%s: ' "$marker"
    cat "$marker"
  fi
done
printf 'backup stamp: %s\n' "$STAMP"
```

Keep `$STAMP` and this shell session safe; rollback uses both. The marker backup
is the last commit that actually served traffic.

## 2. Nginx: add both AI locations

The repository template is `619-erp-backend/infra/nginx/myptstudio.conf`. Diff
it against the live file, then carry over only these changes:

1. The frontend `myptstudio.com` vhost has `location /api/ai/` with a 300s read
   timeout and buffering off.
2. The `api.myptstudio.com` vhost has the same block.
3. Keep the old `location /ai/` block for now; the current frontend still uses
   it. It is removed only after the new frontend is serving (step 5).

```bash
sudo diff -u /etc/nginx/sites-available/myptstudio.conf \
  /opt/myptstudio/619-erp-backend/infra/nginx/myptstudio.conf || true
```

Edit the live file with `sudoedit /etc/nginx/sites-available/myptstudio.conf`.
Do not replace the whole file blindly: the live box may contain certificates,
redirects, rate limits or hostnames this template does not know about.

Confirm there is exactly one `/api/ai/` block in each vhost, then validate and
reload. Do not remove `/ai/` yet.

```bash
sudo grep -n 'server_name\|location /api/ai/' /etc/nginx/sites-available/myptstudio.conf
sudo nginx -t
sudo systemctl reload nginx
```

If `nginx -t` fails, do not reload. Restore from `/etc/nginx.bak.$STAMP` first.

## 3. Backend first

The new frontend needs the ERP endpoint, and the old frontend does not. Deploy
the backend before the frontend.

> **Expected short outage:** the old frontend still calls the retired service,
> and the retired service calls backend endpoints this release removes. The old
> Client Assistant therefore stops working when the backend switches, until the
> new frontend is verified. Schedule a maintenance window; frontend build time
> is part of that window.

```bash
set -eu
cd /opt/myptstudio/619-erp-backend
git fetch origin main
git checkout main
git pull --ff-only origin main
BACKEND_SHA="$(git rev-parse HEAD)"
cd /opt/myptstudio
docker compose -f "$COMPOSE_FILE" build \
  --build-arg GIT_SHA="$BACKEND_SHA" \
  "$BACKEND_SVC"
```

The Client Assistant writes `organization_id`, `request_id`, `routed_via`,
`cost_inr` and `usage_source` to `ai_usage_log`. Probe the schema in the newly
built image before starting it. The probe prints only column names.

```bash
docker compose -f "$COMPOSE_FILE" run --rm --no-deps -T "$BACKEND_SVC" node - <<'NODE'
const pool = require('./src/db/pool');
const required = ['organization_id', 'request_id', 'routed_via', 'cost_inr', 'usage_source'];
pool.query(
  `SELECT column_name
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_usage_log'
      AND column_name = ANY($1)`,
  [required],
).then((r) => {
  const got = r.rows.map((x) => x.column_name).sort();
  console.log(got.join(','));
  process.exit(got.length === required.length ? 0 : 1);
}).catch((e) => {
  console.error('schema probe failed:', e.code || e.message);
  process.exit(1);
});
NODE
```

Only if that probe exits non-zero, apply the additive migrations:

```bash
docker compose -f "$COMPOSE_FILE" run --rm --no-deps "$BACKEND_SVC" npm run migrate
```

Then start the backend and verify the commit and the route. The verify script
moves `${MARKER}.new` into place only after the health check matches, so write
the expected SHA to `.new` first:

```bash
printf '%s\n' "$BACKEND_SHA" > /opt/myptstudio/.backend-deployed-sha.new
docker compose -f "$COMPOSE_FILE" up -d "$BACKEND_SVC"
bash /opt/myptstudio/619-erp-backend/scripts/deploy/verify-serving.sh \
  "$BACKEND_SHA" /opt/myptstudio "$BACKEND_SVC" \
  http://127.0.0.1:5000/api/health /opt/myptstudio/.backend-deployed-sha

# No token: 401 is the proof that nginx/Next/the backend route is reachable.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:5000/api/ai/client-agent/chat/stream \
  -H 'Content-Type: application/json' \
  --data '{"clientId":"probe","message":"hi"}'
```

Expected body status: `401`. A `404` here means the old backend image is still
serving; a `502` means the container or port is wrong.

## 4. Frontend second

Build the frontend with the API origin that the Next rewrite uses. Replace the
origin only if this deployment uses a different one.

```bash
set -eu
cd /opt/myptstudio/619-erp-frontend
git fetch origin main
git checkout main
git pull --ff-only origin main
FRONTEND_SHA="$(git rev-parse HEAD)"
cd /opt/myptstudio
docker compose -f "$COMPOSE_FILE" build \
  --build-arg NEXT_PUBLIC_API_URL=https://api.myptstudio.com \
  --build-arg GIT_SHA="$FRONTEND_SHA" \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg APP_VERSION="$(node -p "require('/opt/myptstudio/619-erp-frontend/package.json').version")" \
  "$FRONTEND_SVC"
printf '%s\n' "$FRONTEND_SHA" > /opt/myptstudio/.frontend-deployed-sha.new
docker compose -f "$COMPOSE_FILE" up -d "$FRONTEND_SVC"
bash /opt/myptstudio/619-erp-frontend/scripts/deploy/verify-serving.sh \
  "$FRONTEND_SHA" /opt/myptstudio "$FRONTEND_SVC" \
  http://127.0.0.1:3000/api/health /opt/myptstudio/.frontend-deployed-sha
```

Prove the public route through the frontend vhost. No token is sent:

```bash
curl -isS -m 10 https://myptstudio.com/api/ai/client-agent/chat/stream \
  -H 'Content-Type: application/json' \
  --data '{"clientId":"probe","message":"hi"}' | head -5
```

Expected: `401` with a JSON error envelope. `200` with HTML means the request
reached the page shell instead of the Next rewrite.

## 5. Retire the old service and its configuration

Only after the new frontend is verified:

```bash
set -eu
cd /opt/myptstudio

if [ -n "${AI_SVC:-}" ]; then
  docker compose -f "$COMPOSE_FILE" stop "$AI_SVC" || true
  docker compose -f "$COMPOSE_FILE" rm -f "$AI_SVC" || true
fi

# Remove retired keys without printing their values.
for key in AI_SERVICE_URL SERVICE_AUTH_SECRET AI_ALLOWED_ORIGINS ALLOWED_ORIGINS ERP_BACKEND_URL AI_QUOTA_MODE AI_LOG_LEVEL AI_RATE_LIMIT_MAX; do
  if sudo grep -q "^${key}=" .env; then
    sudo sed -i "/^${key}=/d" .env
  fi
done
```

Remove the `ai`/`mps-ai` service and any `ai-logs` volume from the live compose
file. Also remove any `AI_SERVICE_URL` build arg from the frontend service — the
current Dockerfile no longer declares it. Confirm the service is gone, then
validate:

```bash
docker compose -f "$COMPOSE_FILE" config -q
docker compose -f "$COMPOSE_FILE" config --services
```

If the compose file still defines the service, the next `docker compose up -d`
can recreate it. Remove the block rather than only stopping the container.

Now remove the retired nginx route. Confirm the line range first, then delete
exactly that top-level `location /ai/ { ... }` block and its comment:

```bash
sudo grep -n -A18 -B8 'location /ai/' /etc/nginx/sites-available/myptstudio.conf || true
```

Edit with `sudoedit /etc/nginx/sites-available/myptstudio.conf`, then validate
and reload. If `nginx -t` fails, restore the backup; do not reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
# The route may also live in an included file; this must print nothing.
sudo nginx -T 2>/dev/null | grep -nE '^[[:space:]]*location[[:space:]]+/ai/' || true
```

## 6. Smoke checks

Backend logs, filtered to the new events only:

```bash
docker compose -f "$COMPOSE_FILE" logs --since=10m "$BACKEND_SVC" \
  | grep -E 'client_agent_(answered|model_failed|client_disconnected|authorise_failed)' \
  | tail -20 || true
```

In a signed-in trainer browser:

1. Open a client, open Ask AI, send one question.
2. The answer streams incrementally and ends with a completed answer.
3. The source chips match the tools the backend reports.
4. Press stop mid-answer; the request is cancelled and no completed usage row
   is written.
5. DevTools Network shows `POST /api/ai/client-agent/chat/stream` only. There
   must be no `/ai/client-agent/...` request.

One answered turn should produce one `ai_usage_log` row with:
`intent_type='client_agent'`, non-null `request_id` and `organization_id`.
Query only counts and column names; do not dump prompt data.

## 7. Rollback

Rollback is image/reverse-order first. The database migrations are additive;
do not drop columns while remediated code may still run.

### Backend image

```bash
set -eu
cd /opt/myptstudio/619-erp-backend
test -n "${STAMP:?run the snapshot block first}"
PREVIOUS_BACKEND_SHA="$(cat "/opt/myptstudio/.backend-deployed-sha.bak.$STAMP")"
test -n "${PREVIOUS_BACKEND_SHA:-}"
git fetch --all
git checkout --detach "$PREVIOUS_BACKEND_SHA"
cd /opt/myptstudio
docker compose -f "$COMPOSE_FILE" build --build-arg GIT_SHA="$PREVIOUS_BACKEND_SHA" "$BACKEND_SVC"
printf '%s\n' "$PREVIOUS_BACKEND_SHA" > /opt/myptstudio/.backend-deployed-sha.new
docker compose -f "$COMPOSE_FILE" up -d "$BACKEND_SVC"
bash /opt/myptstudio/619-erp-backend/scripts/deploy/verify-serving.sh \
  "$PREVIOUS_BACKEND_SHA" /opt/myptstudio "$BACKEND_SVC" \
  http://127.0.0.1:5000/api/health /opt/myptstudio/.backend-deployed-sha
```

If no previous SHA marker exists, use the SHA the release manager recorded
before the cutover (the marker is written by the verify script only after a
successful deploy).

### Frontend image

```bash
set -eu
test -n "${STAMP:?run the snapshot block first}"
FRONTEND_SHA="$(cat "/opt/myptstudio/.frontend-deployed-sha.bak.$STAMP")"
test -n "${FRONTEND_SHA:-}"
cd /opt/myptstudio/619-erp-frontend
git fetch origin main
git checkout --detach "$FRONTEND_SHA"
cd /opt/myptstudio
docker compose -f "$COMPOSE_FILE" build \
  --build-arg NEXT_PUBLIC_API_URL=https://api.myptstudio.com \
  --build-arg GIT_SHA="$FRONTEND_SHA" \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg APP_VERSION="$(node -p "require('/opt/myptstudio/619-erp-frontend/package.json').version")" \
  "$FRONTEND_SVC"
printf '%s\n' "$FRONTEND_SHA" > /opt/myptstudio/.frontend-deployed-sha.new
docker compose -f "$COMPOSE_FILE" up -d "$FRONTEND_SVC"
bash /opt/myptstudio/619-erp-frontend/scripts/deploy/verify-serving.sh \
  "$FRONTEND_SHA" /opt/myptstudio "$FRONTEND_SVC" \
  http://127.0.0.1:3000/api/health /opt/myptstudio/.frontend-deployed-sha
```

The checkout is now detached. After the fix is on `main`, run
`git -C /opt/myptstudio/619-erp-frontend checkout main` (and the backend
equivalent) so the next normal deploy is not a no-op.

### Nginx

```bash
sudo mv /etc/nginx "/etc/nginx.failed.$(date -u +%Y%m%dT%H%M%SZ)"
sudo mv "/etc/nginx.bak.$STAMP" /etc/nginx
sudo nginx -t
sudo systemctl reload nginx
```

Restoring the nginx backup also restores `/ai/`. The old frontend then needs
the old AI service running again, and the old backend image (which restores the
service-attach and quota/usage bridge). Step 5 deleted the service secrets from
`.env`, so restore the pre-cutover environment too. If the old AI service was
removed from the live compose file, restore the backed-up compose file first;
the `.env` restore is required either way:

```bash
sudo cp -a "/opt/myptstudio/.env.bak.$STAMP" "/opt/myptstudio/.env"
sudo cp -a "/opt/myptstudio/${COMPOSE_FILE}.bak.$STAMP" "/opt/myptstudio/${COMPOSE_FILE}"
AI_SVC="$(docker compose -f "$COMPOSE_FILE" config --services | grep -m1 -E '^(ai|mps-ai|mps_ai)$' || true)"
test -n "${AI_SVC:-}"
docker compose -f "$COMPOSE_FILE" up -d "$AI_SVC"
```

Restoring `.env` also reverts any unrelated edit made after the snapshot. If
that matters, merge the retired keys back by hand instead of copying the file.

Rollback triggers: any failed route check, a stream that does not complete,
missing usage attribution, tenant/client authorisation failure, or an
unexplained 5xx increase. Record the trigger, the SHA restored, and the result.

## 8. Guardrails

- Do not deploy the old `mps-ai` compose snippet. It is retired and its backend
  endpoints no longer exist.
- Do not set `AI_SERVICE_URL`; it is not read by the current frontend.
- Do not remove `SERVICE_AUTH_SECRET` until the old AI service is stopped; the
  old service boots hard without it.
- Do not run migrations speculatively. The schema probe above is the gate.
- Do not print `.env` or provider keys in logs, tickets or chat.
