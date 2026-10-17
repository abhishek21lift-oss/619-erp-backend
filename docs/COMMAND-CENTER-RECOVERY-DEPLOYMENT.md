# Command Center Docker Recovery — Deployment Evidence

Status: S1 complete (production path verified from authorized repo/workflow evidence). S2–S5 NOT EXECUTED — requires live VPS access (docker group, /opt/myptstudio). Rung 4/5 NOT declared operational.

## Confirmed production topology (S1 — external workflow evidence)
- Project root: `/opt/myptstudio/` (deploy.yml line 33, cc-recovery.sh default, verify-serving.sh reference).
- Repo checkout on production: `/opt/myptstudio/619-erp-backend/` (deploy.yml line 33, 49).
- Compose expected: `/opt/myptstudio/docker-compose.yml` (or `compose.yaml`; cc-recovery.sh searches both).
- Health probe (local to host): `http://127.0.0.1:5000/api/health` (deploy.yml line 49; verify-serving.sh default).
- Access mechanism: GitHub Actions `appleboy/ssh-action` via `secrets.HOST`, `secrets.USERNAME`, `secrets.SSH_KEY` (deploy.yml / cc-recovery.yml). Host endpoint REDACTED — not inferable from repo.

## Architecture reconciliation (user-clarified, repo-verified)
- Production services: `myptstudio-backend`, `myptstudio-frontend`, Redis, AI, WhatsApp.
- Repo service names (`erp-api`, `erp-worker`) are defaults; production names must match live containers (`CC_API_CONTAINER`, `CC_WORKER_CONTAINER`).
- Rung 4 (`worker.restart`): only available when a SEPARATE worker container exists. If production embeds workers in the backend process, `CC_WORKER_CONTAINER` should remain unset (or point to a different container), and rung 4 stays unavailable (ref: `container-recovery.js` refuses same-name targets; `commands.service.js` `unavailable`). Do not claim rung 4 works without live verification of a separate container.
- Rung 5 (`container.restart`): last resort; requires rung 4 to have been attempted (ladder precondition via `restartVerification.apiRestartLadderReason()`). API restart is self-verifying via `activity_log` (`recordApiRestartRequest` → new process `verifyPendingApiRestarts`). Response may never arrive; status recovered by polling `/commands/container.restart/status/:requestId`.

## Reference design verified by reading
- Proxy service (`docker-compose.yml` lines 243–290): pinned `wollomatic/socket-proxy:1.13.1@sha256:3935b...`; profile `['recovery']`; `-allowPOST` regex anchored to `/containers/(api|worker)/restart`; `-allowfrom=api`; `-allowhealthcheck`; `expose` 2375 (not published); `read_only`; `cap_drop: [ALL]`; `group_add: ${DOCKER_GID}`; socket `:ro`.
- API container: NO direct `/var/run/docker.sock` mount (deliberate; `DOCKER_PROXY_URL` points to proxy).
- Safety: one verb only (`RESTART_PATH`); targets from env never user input; names validated by `CONTAINER_NAME_RE`; refused if same; proxy refuses arbitrary paths.

## S1–S5 execution checklist (safe order — do not skip)
1. S1 — Confirm host/path (done via workflow evidence; actual host address requires external confirmation from deploy/CI).
2. S2 — On production VPS with `docker` group: `stat /var/run/docker.sock`; `docker ps --format '{{.Names}}'`; read `/opt/myptstudio/docker-compose.yml`; verify `CC_API_CONTAINER` / `CC_WORKER_CONTAINER` match reality.
3. S3 — Read production `.env` at `/opt/myptstudio/`: confirm `DOCKER_PROXY_URL`, `COMPOSE_PROFILES=recovery`, `DOCKER_GID` matches socket gid, `ADMIN_DATABASE_URL`, proxy profile active.
4. S4 — Only if S1–S3 pass: `bash scripts/deploy/cc-recovery.sh inspect`; if ambiguous/unsafe → STOP; else `apply` (writes `docker-compose.override.yml` beside production, starts proxy, recreates ONLY API); then `verify` (tests `POST /containers/create` refused, health, expose-only).
5. S5 — Before any rung 4/5: proxy healthy; worker restarted first; typed confirmation = command name; expect API response loss; recover outcome via status endpoint / `activity_log`.

## Rung dependency (prevent false claims)
- Rung 3 (`recovery.run`) must not auto-escalate.
- Rung 4 requires separate container; if embedded, unavailable (ref: `commands.service.js` `unavailable`).
- Rung 5 requires rung 4 in ladder window (`LADDER_WINDOW_MS`); has precondition (`apiRestartLadderReason()`); records request first (durable to `activity_log`); verifies on new boot.
- Cooldown (60s, distributed via Redis / local fallback) prevents loops.
- Audit: `commands.run()` records actor, request id, `health_before`, outcome; never throws for operational failure (renders during incident).

## What is NOT verified (blocked by missing live access — do not claim)
- Actual VPS IP / hostname.
- Live `docker ps` container names / health / proxy status.
- Production `DOCKER_GID` (likely 986 per build, must verify on host).
- Production `activity_log` self-restart state.
- Actual rung 4/5 operational readiness.

## Updated environment template (`.env.example`)
- `DOCKER_PROXY_URL=http://docker-socket-proxy:2375`
- `COMPOSE_PROFILES=recovery`
- `DOCKER_GID=986`
- `CC_API_CONTAINER=myptstudio-backend` (production-aligned; must match live container)
- `CC_WORKER_CONTAINER=myptstudio-worker` (only if separate; else leave unset — rung 4 unavailable)

## References (verified locally, not fabricated)
- `src/modules/command-center/container-recovery.js`
- `src/modules/command-center/commands.service.js`
- `src/modules/command-center/restart-verification.js`
- `.github/workflows/deploy.yml` (line 33/37/41/49)
- `scripts/deploy/cc-recovery.sh`
- `scripts/deploy/verify-serving.sh`
- `docker-compose.yml` (proxy service definition)
