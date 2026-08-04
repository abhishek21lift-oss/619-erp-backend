# MY PT STUDIO — Command Center: Implementation Plan

**Status:** plan only, nothing built yet.
**Survey date:** 2026-08-04, against `main` @ `b86b9db`.

Written after searching the repository (the brief's §18) and after establishing
what this deployment can actually observe. Both matter: roughly 40% of the
requested surface already exists in some form, and two whole modules cannot be
built on the current infrastructure at all.

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

## 2. Infrastructure reality — what cannot be built as specified

`render.yaml` declares `runtime: node`, `plan: free`,
`startCommand: node src/server.js`. **This is not a VPS and not a Docker
deployment.** No Docker socket, no host filesystem, no useful `/proc`, no
container API. Grepping confirms the codebase has never touched `dockerode`,
`docker.sock`, `os.cpus()` or `/proc/stat`.

| Brief | Verdict | Why |
|---|---|---|
| §2 VPS Monitor — CPU %, RAM %, Disk %, network, load average, temperature, process count | **Not buildable** | Render exposes no host metrics. `os.totalmem()` inside the container reports the *host's* memory, not this service's share — printing it would be a confident lie on an ops screen. Disk, network and temperature have no source at all. |
| §3 Docker Center — containers, image version, restart count, logs button, restart button | **Not buildable** | `runtime: node`. There are no containers to enumerate and no socket to enumerate them with. The repo's `Dockerfile` / `docker-compose.yml` are local-development only. |
| §7 Workers — per-worker restart / restart count | **Partial** | Workers run **in-process** (`server.js:605`, `RUN_WORKERS !== '0'`). There is no separate worker process, so "restart the AI worker" means restarting the whole service. Job counts, concurrency and per-queue state are all real. |
| §13 Live Logs | **Partial** | `pino` writes to stdout; Render keeps them, the app cannot query them. Needs a deliberate sink — decision D4. |
| §14 Commands — restart backend, restart Redis | **Not buildable in-process** | A process cannot restart its own host. Possible only via the Render API with a key — decision D3. Clear queue, flush cache, run health check, test SMTP / AI / DB are all fine. |
| §2/§10 CPU % | **Substitutable** | `process.cpuUsage()` gives this process's own CPU time, and event-loop lag is the number that actually predicts user-visible slowness. Both are honest; a host CPU gauge is not. |

**Proposed rule for this build: the Command Center never renders a number it
cannot actually measure.** An ops console showing a plausible fabricated CPU %
is worse than one showing "not available on this host", because someone will
make a 3am decision on it. Every panel that cannot be fed will say what it needs
— a VPS, a Docker socket, a Render API key — instead of rendering a placebo.

---

## 3. What replaces the impossible modules

Not less ambition — a substitution of things that are true.

**Runtime Monitor** (replaces §2 VPS Monitor)
`process.memoryUsage()` RSS / heap used / heap total / external;
`process.cpuUsage()` as a share of wall time between samples; **event-loop lag**
p50/p99 via `perf_hooks.monitorEventLoopDelay`; active handles and requests;
`process.uptime()`; GC pause time via `PerformanceObserver`; Node and app
version; pg pool total / idle / waiting. This is the real health of the service.

**Platform Monitor** (replaces §3 Docker Center)
Render service state, latest deploy id / status / commit, instance restart count
and "running since" — from the Render API when a key is supplied, otherwise the
panel says so. Plus Supabase project health and Vercel deployment state, both of
which have APIs.

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

## 6. Decisions needed

**D1 — Transport.** SSE (recommended) or WebSocket? SSE needs no dependency and
fits the existing stack; WS adds `ws` and buys nothing for one-way push.

**D2 — The impossible modules.** For VPS Monitor and Docker Center:
(a) replace with Runtime Monitor + Platform Monitor as in §3;
(b) keep the cards visible but permanently "requires a VPS / Docker host";
(c) plan a migration off Render free onto a real VPS, at which point both become
buildable exactly as specified.

**D3 — Render API key.** With a `RENDER_API_KEY`, Platform Monitor gains deploy
status, instance restarts and "running since", and "Restart Backend" becomes a
real button. Without it, those stay unavailable.

**D4 — Logs.** (a) in-memory ring of the last ~2000 lines: zero cost, lost on
restart, current instance only; (b) a `system_logs` table with retention:
durable and queryable, costs writes; (c) ship to an external sink (Better Stack,
Axiom) and link out. Leaning (a) for Phase 8, with (b) for `error` level only.

**D5 — Worker restart semantics.** Workers are in-process, so should "Restart
Worker" mean pause+resume the BullMQ workers (safe, in-process), or a full
service restart via the Render API (D3)?

---

## 7. Explicit non-goals

- No fabricated metrics. A card with no source says so.
- No second Redis client, no second BullMQ registry, no second health endpoint.
- No mutation of tenant data from this console. It reads infrastructure and
  performs allow-listed operational actions only.
- Not a replacement for Sentry. Sentry stays the error tracker; this correlates
  and controls.
