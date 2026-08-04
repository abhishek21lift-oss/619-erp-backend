# MY PT STUDIO — Command Center: Implementation Plan

**Status:** decisions locked (§3). Phase 1 in progress.
**Survey date:** 2026-08-04, against `main` @ `b86b9db`.

Written after searching the repository (the brief's §18) and after establishing
what production actually is. Roughly 40% of the requested surface already exists
in some form and must be reused rather than rebuilt (§1).

**Correction on record:** the first draft of §2 claimed VPS monitoring and
Docker control were impossible, because it took `render.yaml` for the
deployment. It is not — production is a Hostinger VPS running docker compose,
and `docker-compose.yml` says so in its own header. Everything in the brief is
buildable. §2 is rewritten; the wrong version is not kept, but the mistake is
noted here because it changed the shape of the plan.

---

## 1. What already exists — reuse map

The brief says do not duplicate services, Redis connections, Docker checks or
health endpoints. Here is what is already there and must be built *on*, not
beside.

| Requested module | Already in the repo | Where |
|---|---|---|
| Health endpoint | `GET /api/health` (liveness) and `GET /api/super-admin/system-health` (deep: db latency, pool, migrations, db size, process memory, uptime, errors_24h, BullMQ summary) | `src/server.js:321`, `src/modules/platform/super-admin/operations.js:372` |
| Queue / BullMQ | `collectQueueStats()`, `summarize()`, per-queue waiting/active/delayed/completed/failed/paused, all timeout-guarded | `src/lib/queueHealth.js` |
| Redis | One shared client with `ping()`, `isReady()`, `isConfigured()`, `ensureReady()`, separate worker connection | `src/lib/redis.js` |
| Security Center | login events, threats, sessions, overview | `src/modules/platform/super-admin/security.js` |
| AI Center | usage overview, by-model, by-studio, trend, provider settings | `src/modules/platform/super-admin/ai.js`; tables `ai_usage_log`, `ai_provider_settings`, `platform_ai_settings` |
| Storage | overview, by-studio, trend, largest | `src/modules/platform/super-admin/storage.js` |
| SMTP | `isConfigured()`, `describeConfig()`, `verifyConnection()`, typed error explanations | `src/lib/email.js`, `scripts/verify-smtp.js` |
| Request timing | every `/api/*` request already logs `{method,url,status,ms,req_id}` | `src/server.js:295` |
| Frontend shell | `/platform` with tab router: Overview, Studios, Finance, Activity, Registrations, Coupons | `src/app/platform/` |
| UI kit | `Card`, `Badge`, `Button`, `KpiCard`, `StatCard`, `GlassTable`, `DonutChart`, `chart.tsx`, `Skeleton`, `PageHeader`, `cn` — already glass-styled | `src/components/ui/` |
| Client contract | `api.superAdmin.systemHealth()` and the `SystemHealth` type | `endpoints/platform.ts:184`, `types.ts:1773` |
| Auth gate | `auth → requireSuperAdmin → requireSuperAdminMfa` on the whole `/api/super-admin` mount | `src/server.js` |
| SSE precedent | AI generation already streams `text/event-stream` | `src/routes/ai.js` |
| Charts / motion | `recharts`, `framer-motion` installed | frontend `package.json` |

**Consequence:** the Command Center is a new *tab* on `/platform` plus a
`command-center` service layer that composes existing collectors — not a new
app, and not a second health stack.

---

## 2. Infrastructure reality — CORRECTED

**The first version of this section was wrong.** It read `render.yaml` and
concluded the platform runs on Render free, and therefore that VPS monitoring
and Docker control were impossible. `docker-compose.yml` says otherwise, in its
own header:

> "render.yaml describes that topology for Render. Nothing described it for the
> VPS, **which is where the app actually runs**."

Production is a **Hostinger VPS running docker compose**. `render.yaml` is the
stale artefact. Confirmed by `.github/workflows/deploy.yml`: push to `main` →
SSH → `cd /opt/myptstudio` → `docker compose build backend && up -d backend`.

Live topology:

| Container | Role | Notes |
|---|---|---|
| `redis` | `redis:7-alpine` | bound to `127.0.0.1:6379`, appendonly, `maxmemory 256mb`, `noeviction`, compose healthcheck |
| `api` | the Express app | `127.0.0.1:5000`, `RUN_WORKERS=0` |
| `worker` | `node src/workers/index.js` | `RUN_WORKERS=1`, `stop_grace_period: 30s` |

**Everything the brief asked for is buildable.** Host CPU/RAM/disk/load/
temperature/process count come from `/proc` and `/sys`; Docker Center comes from
the Docker Engine API; the `worker` container is genuinely separate, so
per-worker restart is real, not a euphemism for restarting everything.

### Three things that must be resolved on the box

**A. The repo's compose file is not the one that runs.** Its own header says the
live file is at `/opt/myptstudio/docker-compose.yml`, outside this repository,
and the deploy script targets a service called **`backend`** while the repo file
defines **`api`**. Service names, mounts and volumes must be read off the box
before the Docker collector can name anything correctly.

**B. The API container cannot see Docker or the host today.** Nothing mounts
`/var/run/docker.sock`, `/proc` or `/sys` into it. Without those mounts the
collectors return "unavailable" — correctly, but uselessly.

**C. The container runs as a non-root user.** `Dockerfile` line 12 is
`USER express` (uid 1001). Even with the socket mounted, `/var/run/docker.sock`
is normally `root:docker 0660`, so uid 1001 cannot read it.

### How to grant access — recommended shape

Mounting the raw Docker socket into an internet-facing API container is
effectively handing out root on the VPS: anything that can talk to that socket
can start a privileged container and own the host. So:

```yaml
  # Allow-listed Docker access. The API never touches the raw socket.
  dockerproxy:
    image: tecnativa/docker-socket-proxy
    restart: unless-stopped
    environment:
      CONTAINERS: 1       # list + inspect
      POST: 1             # needed for restart
      IMAGES: 1
      INFO: 1
      # everything else stays 0: no EXEC, no VOLUMES, no SECRETS, no SWARM
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    ports:
      - '127.0.0.1:2375:2375'

  api:
    environment:
      DOCKER_HOST: tcp://dockerproxy:2375
    volumes:
      - /proc:/host/proc:ro     # host CPU, memory, load, process count
      - /sys:/host/sys:ro       # thermal zones, block devices
```

With `EXEC: 0` the socket proxy cannot be used to run commands inside
containers, which is the escalation path that matters. Host `/proc` and `/sys`
are read-only mounts and expose no write surface.

This is a change to the **live** compose file, which this repo cannot make. It
needs to be applied on the box (decision D6 below).

---

## 3. Decisions — LOCKED

| # | Decision | Consequence |
|---|---|---|
| **D1** | **WebSocket** | Adds `ws` to the backend. Nginx in front of the VPS needs `Upgrade`/`Connection` headers proxied for `/api/command-center/stream`. Polling every 5s remains the fallback. |
| **D2** | **Real VPS monitoring. Ignore Render.** | `/proc` + `/sys` + Docker Engine API. `render.yaml` should be deleted or marked stale so nobody reads it as truth again. |
| **D3** | **No Render API key** | Nothing lost — Render is not production. |
| **D4** | **Hybrid logs** | ring buffer (hot, in-memory) → critical lines → `system_logs` table → archive/retention. |
| **D5** | **Escalation ladder for recovery** | pause → drain in-flight → resume → if still unhealthy restart worker → if still unhealthy restart container. Never jump straight to a restart. |
| **D6** | **OPEN — needs action on the VPS** | The compose changes in §2. Until then Docker/VPS cards report "not mounted" rather than guessing. |

### D5 in detail — the recovery ladder

Each rung has an explicit health verdict and a stop condition. Nothing escalates
on its own without either an operator click or an explicit auto-recover policy.

```
unhealthy signal
  └─ 1. PAUSE queue          BullMQ pause(), in-flight jobs keep running
     └─ 2. DRAIN             wait for active == 0, bounded (30s, matches
                             stop_grace_period — a renewal job killed mid-flight
                             is a card charged with no membership row)
        └─ 3. RESUME         re-check health
           └─ 4. RESTART WORKER    docker restart <worker>  (SIGTERM, 30s grace)
              └─ 5. RESTART CONTAINER  the api/backend container
                 └─ 6. STOP + PAGE     never loop; hand to a human
```

### One Click Recovery

The flow the brief asks for, made safe:

```
detect  →  Guardian produces a finding with a confidence score
        →  finding maps to a NAMED, allow-listed remediation
        →  operator sees: what is wrong, why, what will run, blast radius
        →  ONE CLICK  (typed confirmation for anything destructive)
        →  pre-flight snapshot captured
        →  remediation runs, streamed live over the WebSocket
        →  post-flight health check
        →  success → notify owner  |  failure → auto-rollback to previous rung
        →  the whole run written to activity_log with actor + before/after
```

Rules, because this button can take production down:
- **Never auto-executes below 95% confidence.** Default is suggest-only;
  auto-recover is opt-in per remediation.
- Every remediation is **idempotent** and has a **declared blast radius**
  (which containers, expected downtime).
- **Circuit breaker:** the same remediation may not fire twice within 10
  minutes, and 3 failures in an hour disables auto-recovery until cleared.
- A **dry-run** mode renders the exact commands without executing.

---

## 4. Architecture

```
src/modules/command-center/
  collectors/            one file per source; each exports async collect()
    runtime.collector.js       process, memory, event-loop lag, GC
    database.collector.js      pool, pg_stat_activity, pg_stat_statements, size, migrations
    redis.collector.js         wraps lib/redis.js ping + INFO
    queue.collector.js         wraps lib/queueHealth.js (NO new BullMQ clients)
    ai.collector.js            ai_usage_log aggregates + provider health
    smtp.collector.js          wraps lib/email.js describeConfig/verifyConnection
    security.collector.js      login_events, rate-limit hits, RLS/env posture
    http.collector.js          in-memory request-timing ring: p50/p95/p99, slow endpoints
    platform.collector.js      Render / Supabase / Vercel APIs, when keys exist
  registry.js            name -> { collector, ttl, severity rules }
  snapshot.service.js    parallel collect, per-collector timeout, cache
  guardian.service.js    rules engine -> findings; optional LLM narration
  alerts.service.js      finding -> alert lifecycle (open/ack/resolved) + channels
  commands.service.js    allow-listed actions, each audited
  command-center.routes.js
```

Non-negotiables, all from §18:

- Every collector is **read-only** and **individually timeout-guarded**; one dead
  dependency degrades one card, never the page. This mirrors how
  `queueHealth.js` already behaves.
- **No new Redis client.** `lib/redis.js` is the only one.
- **No new health endpoint.** `/api/health` stays a liveness probe;
  `system-health` is refactored to call the same collectors so the two can never
  disagree.
- Every collector returns
  `{ status, value, latency_ms, checked_at, unavailable_reason? }`
  so the UI renders "unavailable" as a first-class state.

**Transport — recommendation: SSE, not WebSocket.** The repo already streams
`text/event-stream` for AI, it needs no new dependency, it survives the Vercel
`/api/*` rewrite unchanged, and it reconnects natively. A `ws` server on Render
free — which spins down after 15 minutes idle — buys nothing here, because this
is one-directional server→client push. Commands stay ordinary POSTs. Polling at
5s is the documented fallback when the stream drops.

**Security.** Mounts behind the existing
`auth → requireSuperAdmin → requireSuperAdminMfa`. Every command is allow-listed
by name, rate-limited, and written to `activity_log` with the actor. A console
with "flush cache" and "clear queue" buttons is a privileged surface and is
treated as one.

---

## 5. Phases

Each phase ends with: tests green, lint clean, a verification note, one commit.
Nothing merges that breaks an existing feature.

| Phase | Scope | Deliverable |
|---|---|---|
| **0** | This document + decisions D1–D5 | agreed scope |
| **1** | Collector framework: `registry`, `snapshot.service`, timeout/cache harness, plus `runtime` + `database` + `redis` + `queue` collectors. `GET /api/command-center/snapshot`. Refactor `system-health` onto it. | Real data, one endpoint, no UI |
| **2** | Remaining collectors: `ai`, `smtp`, `security`, `http` request-timing ring, `platform`. Per-domain endpoints from §16. | Full backend surface |
| **3** | SSE `GET /api/command-center/stream` + per-card diffing so only changed cards re-render. Polling fallback. | Live updates |
| **4** | Frontend `CommandCenterTab` on `/platform`: card grid, status colours, sparklines, skeleton and unavailable states, framer-motion transitions. Built from the existing `ui/` kit. | The console |
| **5** | Commands: run health check, test SMTP, test AI, test DB, clear queue, flush cache — allow-listed, audited, confirm-gated; destructive ones behind a typed confirmation. | Control |
| **6** | Alert Center: thresholds → findings → alert lifecycle, history table, channels (browser first; email/WhatsApp reuse existing senders). | Alerting |
| **7** | AI Guardian: deterministic rules engine first (correlations such as "queue depth rising **and** Redis latency rising → worker starvation"), then optional LLM narration over the *finding*, never over raw metrics. Confidence shown; recommendations advisory only. | Diagnosis |
| **8** | Live Logs, per decision D4. | Logs |

**Phase 1 is unblocked and can start immediately.** Phases 3, 8 and the
restart-actions in 5 depend on the decisions below.

---

## 6. Explicit non-goals

- No fabricated metrics. A card with no source says so.
- No second Redis client, no second BullMQ registry, no second health endpoint.
- No mutation of tenant data from this console. It reads infrastructure and
  performs allow-listed operational actions only.
- Not a replacement for Sentry. Sentry stays the error tracker; this correlates
  and controls.
