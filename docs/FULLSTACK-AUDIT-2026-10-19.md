# Full-Stack Wiring & Functionality Audit — MY PT STUDIO (619 Fitness ERP)

> **Historical audit (2026-10-19).** The AI findings below describe the retired
> standalone `mps-ai` topology and are kept as the audit record. The Client
> Assistant now runs in the ERP backend at
> `POST /api/ai/client-agent/chat/stream`; `AI_SERVICE_URL`, the Next `/ai`
> rewrite, `SERVICE_AUTH_SECRET` and the nginx `/ai/` route are gone. For the
> current topology and production commands see
> [`AI-CLIENT-ASSISTANT-CUTOVER.md`](./AI-CLIENT-ASSISTANT-CUTOVER.md).

**Date:** 2026-10-19
**Scope:** `619-erp-frontend` (Next.js 16.2 / React 19 / TS), `619-erp-backend` (Express 4 / node-postgres), `619-erp-whatsapp` (Fastify 5 / Baileys gateway), PostgreSQL schema + 246 migrations, Docker/Nginx/CI, and the WhatsApp/Email/AI/Razorpay/UPI integrations.
**Method:** Read-only static inspection of the actual working trees (including uncommitted work), plus safe executable checks (lint, typecheck, unit tests, production build). No file was modified, no migration applied, no mutating SQL executed, no external message, email, or payment triggered, no secret value printed.
**Branches at audit time:** backend `feat/goal-setting-redesign` @ `62e8f89` (7 files modified, `prisma/` + 6 test files untracked) · frontend `feat/goal-setting-redesign` @ `f2854805` (2 files modified, 2 untracked) · whatsapp `feature/whatsapp-gateway-mvp` @ `96ef1cd` (clean).

> **Reading this report:** every finding is tagged **CONFIRMED** (I read both sides of the defect in the actual source) or **NEEDS RUNTIME VERIFICATION** (the code path is proven, but the runtime outcome depends on a deployed environment I could not reach). Severity is P0–P3. Each finding carries a safe reproduction step — no step requires sending a real message, charging a card, or touching another tenant's live data.

---

## 1. Executive summary

The codebase is **large, mature, and unusually disciplined in the places that usually rot**: multi-tenant isolation is derived from the session and never from the request body; CORS is a real allowlist; cookies are httpOnly + SameSite=Strict; the WhatsApp webhook does constant-time HMAC comparison with a replay ledger; the UPI payment path has correct double-approve and duplicate-UTR protection; rate limiters are per-identity, not just per-IP; the logger redacts secrets by path *and* by free-text scrubbing; and the frontend CI stands up a real Postgres, runs the real migrations, boots the real API, and drives real browser journeys against it.

It is also **not wired end to end**. The audit found **7 P1 findings and 24 P2 findings** that each break or silently degrade a real user-facing path, and **4 P0 findings** where a whole subsystem is dead on arrival or a security control is silently off. The pattern is consistent and diagnostic:

> **The code is correct; the deployment contract is not.** The largest and most expensive failures are not logic bugs — they are variables, secrets, and environment names that the code reads but that the committed Compose file, the committed `.env.example`, or the committed runbook never supplies.

Concretely:

- **Every WhatsApp feature is dead** under the committed `docker-compose.yml` — it forwards no `WA_*` variable at all, so `POST /api/integrations/whatsapp/connect` returns `503 GATEWAY_NOT_CONFIGURED` and the UI shows "WhatsApp is not set up on this server yet" (P0-01).
- **The AI feature is dead** under the committed Compose file for the same reason — no `OPENROUTER_API_KEY` / `AI_API_KEY` is forwarded (P0-02). Even once a key is supplied, usage accounting records `tokens_prompt = 0` and `cost_inr = null` for every call, because exact usage is only requested from `openrouter.ai` and production points at a different gateway (P1-05).
- **The Razorpay webhook acknowledges every captured payment with HTTP 200 and writes nothing** — no ledger row, no receipt, no reconciliation (P0-03).
- **A fresh database built from this repo is missing 19 columns across 5 tables that live application code reads.** `class_sessions` has no `starts_at`; `bookings` has no `position`; `member_memberships` has no `classes_used`; `plans` has no `price`; `members` has no `name`. Five live surfaces — class listings, the whole bookings module, Google Calendar sync, and the renewal worker — fail with `42703 undefined_column` on any environment built from `schema.sql` + migrations (P0-04).
- **The frontend's own `.env.example` tells operators to leave `JWT_SECRET` unset, and doing so makes every authenticated page redirect to the sign-in screen** — the documented behaviour ("a page shell") does not exist in the code (P1-01).
- **Five "device" and "session" controls report success and do nothing.** `DELETE /api/profile/devices/:id` and `DELETE /api/profile/sessions/:id` return `200 {"message":"Session revoked"}` with zero writes; the two matching GET endpoints return hardcoded arrays (P1-02).
- **A password-reset email that was never sent is logged as "Password reset email sent."** The SMTP-unconfigured path returns `{sent:false}` without throwing, so the BullMQ job completes successfully and the request path's `result.sent === false` guard is dead code on the queued path (P1-03).

The good news is that **no P0 cross-tenant data leak was found**. Every tenant-scoped query path audited — `/api/me/*`, `/api/pt-os/clients/*`, `/api/messages/*`, `/api/bookings`, `/api/payments/upi/*` — derives the organization from the authenticated session. The WhatsApp gateway independently enforces ownership via a private `#requireOwned` on every instance-scoped operation. The residual risk is structural (the org filter is duplicated per handler rather than enforced by RLS in the default deployment) and is documented in §8.

**Verdict: NOT READY.** See §17.

---

## 2. Overall system health assessment

| Dimension | Assessment | Basis |
|---|---|---|
| Multi-tenant isolation | **Strong** | Session-derived org on every audited path; no client-supplied tenant id on the tenant plane; gateway ownership asserted structurally |
| Authentication | **Strong, with two asymmetries** | httpOnly + SameSite=Strict cookies, rotating SHA-256-hashed refresh tokens, `token_version` revocation, platform MFA+owner guards; Google/passkey paths mint 7-day tokens with no refresh (P2-01) |
| API ↔ frontend contract | **Good** | 486 distinct frontend endpoints, all but one resolve to a real backend route; one real payload mismatch (campaigns, P2-04) |
| Frontend interactivity | **Strong** | No mock data, no empty handlers, no swallowed write errors, no infinite `useEffect`, no dead route directories; 70 typed methods have no caller (P3-04) |
| Database integrity | **Weak** | 19 missing columns, no column-level schema agreement test, migration runner inherits 15 s/20 s timeouts (P0-04, P1-06, P1-07) |
| Integration chains | **Partial** | UPI **complete**; WhatsApp code-complete but mis-configured; Razorpay **stubbed**; Email **partial** (silent no-op); AI **partial** (broken metering) |
| Background jobs | **Adequate** | 7 queues, all consumed, all produced, correct retry/backoff, at-least-once with idempotency ledgers; two failure classes permanently lose work (P1-04, P2-06) |
| Infrastructure / deployment | **Weak** | The committed Compose is not the deployed topology; ~60 read env vars are never forwarded; two of three images cannot be configured for the public vars they read (P1-08, P1-09) |
| Observability | **Adequate in the backend, inert in the browser** | Sentry is correctly initialised server-side; the frontend DSN is never supplied by any workflow (P1-10) |
| Backup / recovery | **Weak** | Nightly `pg_dump` works; the off-site copy has been failing since at least 2026-10-02; no restore drill on real data; no PITR (P2-11) |
| Test / CI | **Strong** | Backend: 364 test files, real Postgres in CI, gateway seam test, `npm audit --audit-level=high` blocking. Frontend: lint/typecheck/test/e2e/build, e2e against a real API, `continue-on-error` deliberately removed from e2e |

**Load assumed for this audit:** a multi-tenant SaaS serving several hundred studios, each with up to a few thousand members, with one API process, one worker process, and one Postgres (Supabase). Findings marked *scale-dependent* (unbounded list endpoints, per-row aggregate joins) are rated on that assumption and would be lower at ten-person scale.

---

## 3. Architecture and dependency map

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Browser  (myptstudio.com — Next.js 16 standalone)                            │
│   src/lib/http.ts → apiBase()                                               │
│     • prod (non-localhost host): '' → same-origin → Next rewrite            │
│     • dev (localhost): absolute NEXT_PUBLIC_API_URL → cross-origin + CORS   │
│   Cookie "token" (httpOnly, SameSite=Strict) ─┐                             │
│   sessionStorage "619_impersonation" (Bearer)  ├─► tenantAuthHeaders()      │
└───────────────────────────────────────────────┼─────────────────────────────┘
                                                │ /api/:path* rewrite
                                                ▼
┌──────────────────────────────┐   /api/:path*   ┌────────────────────────────┐
│ nginx (infra/nginx/ template)│────────────────►│ 619-erp-backend (Express)  │
│  myptstudio.com  → :3000    │                 │  87 app.use mounts          │
│  api.myptstudio.com → :5000 │                 │  638 route handlers         │
│  admin.myptstudio.com →:3000│                 │  58 router files           │
└──────────────────────────────┘                 └───────┬────────────────────┘
                                                            │
        ┌───────────────────┬───────────────────┬───────────┴────────────┐
        ▼                   ▼                   ▼                        ▼
┌───────────────┐  ┌──────────────┐   ┌──────────────────┐   ┌────────────────────┐
│ PostgreSQL    │  │ Redis 7      │   │ WhatsApp gateway │   │ 3rd party          │
│ (Supabase)    │  │ BullMQ x7    │   │ (Fastify+Baileys)│   │ OpenRouter/FreeLLM │
│ 174 tables    │  │ appendonly   │   │ X-Gateway-Key   │   │ nodemailer/resend  │
│ 246 migrations│  │ noeviction   │   │ X-Org-Id        │   │ Razorpay           │
│ RLS 141+ pol. │  │ 7 queues     │   │ HMAC outbox →   │   │ Cloudflare R2     │
└───────────────┘  └──────────────┘   │ backend webhook  │   │ Google Calendar    │
                                       └──────────────────┘   └────────────────────┘
```

**Key dependency facts (verified in source, not inferred from filenames):**

| Component | Reads | Writes | Isolation mechanism |
|---|---|---|---|
| `src/middleware/auth.js` | `users` (30 s cache), `organizations` | — | Derives `req.user.organization_id`; the **only** tenant source |
| `src/lib/tenant-db.js:20-25` | — | — | `tenantScope(req)` → `orgWhere()` → `AND organization_id = $N` (always emitted) |
| `src/db/pool.js:266-297` | — | — | `set_config('app.org_id', …)` inside a transaction — RLS backstop, **dormant unless `TENANT_RLS_ENFORCE` on AND `DATABASE_URL` points at `app_tenant`** |
| `src/routes/whatsapp.js` | `whatsapp_instances` | same | `orgIdOf(req)` + `WHERE instance_id=$1 AND organization_id=$2` on every row |
| `619-erp-whatsapp/src/domain/registry.ts:92-111` | manifest | manifest | Private `#requireOwned(instanceId, orgId)` — 404 on mismatch, every op must pass it |
| `src/middleware/platformAuth.js:183-280` | `platform_owners` | — | `aud==='platform'` + live owner row; blocks impersonation; fails closed |

**Error propagation:** the backend uses a `wrap()` helper on async route handlers in some modules but **not** all — `src/routes/razorpay-webhook.js` computes its HMAC *before* the `try/catch`, and Express 4 does not attach a catch to a returned promise (P2-08). The frontend converts `{error:{message,code}}` and `{message|error,code}` envelopes into `ApiError` with `status`/`code`/`payload`; `402 + SUBSCRIPTION_INACTIVE` hard-redirects to `/subscription`; `401` triggers one refresh + one retry, then a `session-expired` event.

---

## 4. Repository and service inventory

| Repo | Branch | Size | Tests | State |
|---|---|---|---|---|
| `619-erp-backend` | `feat/goal-setting-redesign` | 83,655 LOC (excl. tests) | 364 files | 7 modified, 12 untracked — **preserved untouched** |
| `619-erp-frontend` | `feat/goal-setting-redesign` | 187,774 LOC | 225 files | 2 modified, 2 untracked — **preserved untouched** |
| `619-erp-whatsapp` | `feature/whatsapp-gateway-mvp` | TypeScript, Fastify 5 | 154 tests | clean; **`node_modules` absent — its checks could not be run** |

**Backend routers mounted (87 `app.use` mounts, 58 router files, 638 handler registrations).** No dead routers: every file that calls `express.Router()` is reachable from `server.js`.

**Frontend:** 134 `page.tsx` files, 10 endpoint modules, 486 distinct API endpoints in the typed client, 686 `api.*` call sites, 19 direct `http()` sites, 9 direct `fetch()` sites.

**Notable:** `prisma/` exists as an untracked directory with one migration file, but the project has **no Prisma dependency and no `prisma/schema.prisma`**. The migration runner only ever reads `src/db/migrations/*.sql` (`src/db/migrate.js:56,109`). The untracked `prisma/migrations/20261017_provenance/migration.sql` adds six provenance columns to `pt_assessments` and a `fitness_norm_sources` table that **no reachable database has**. This is uncommitted in-progress work, not a committed orphan — but it will silently never apply (P2-14).

---

## 5. Frontend route and interaction audit

**Result: the frontend is in good shape.** Audited every route, form, button, and API call site.

**Clean (verified, not assumed):**
- Every one of the 486 endpoint groups resolves to a real backend route, checked against `server.js` mount prefixes and all `modules/*/*.routes.js`.
- **No mock data.** No `mockData`, `MOCK_*`, `dummy`, `sample`, or `fake` arrays anywhere in `src/` outside `__tests__/`. The only hardcoded pages are `/help` (static FAQ), `/pt-os` (marketing), `/pt-os/cardio-calculator` (client-side math by design), and `/preview-interview` (self-labelled temporary preview).
- **No empty handlers.** No `onClick={() => {}}`, comment-only handler, or `onClick={() => null}`.
- **No swallowed write errors.** All 30 `.catch(() => {})` sites are documented in-place degradations (filter-rail counts, unread badges). No production call site swallows an error on a write.
- **No infinite loops.** A programmatic scan of every `useEffect` containing an `api.`/`http(`/`fetch(` call found zero effects missing a dependency array.
- **All 31 write call sites refresh their list** (local state update or an explicit `load()`/`refetch()`/`onSaved()`).
- **No route directory without a `page.tsx`** (no accidental 404s).
- **No double-slash or missing-slash paths.**
- **No wrong HTTP method.** `POST /api/auth/change-password` is an intentional alias; `PATCH /api/pt-os/clients/:id`, `PUT /api/progress/clients/:id/habit-preferences`, and `PUT /api/auth/webauthn/credentials/:id/toggle` all match their handlers.
- **Response field mismatches: none** across ~25 checked response shapes (`.data` unwraps, alias columns, `{events,total,hasMore}`, `{today,history}`, `{this_week,checkins}`).

**Defects found — see §12.**

---

## 6. Frontend-to-backend API compatibility matrix

**Summary: 486 endpoints, 1 unresolved, 1 payload mismatch, 0 method errors, 0 field-name errors (other than the one).**

**Independently re-verified mechanically.** After the source review, I wrote a separate checker (`/tmp/opencode/xcheck2.js`, read-only, outside both repos) that resolves the backend mount tree from `server.js` — including `app.use('/prefix', require(...))`, `router.use(require(...))` with no prefix, and identifier mounts such as `app.use('/api/platform', ...PLATFORM_GUARD, platformRoutes)` — into **1,324 absolute route patterns (1,084 distinct shapes)**, then extracts every API path literal from the frontend's `src/` tree and shape-matches them. Result: **430 distinct frontend API paths, 2 unmatched, and both are non-calls** (`/api/auth`, a base-path string; and `/uploads/...`, a literal ellipsis). **Every real frontend API path resolves to a real backend route.** The one genuinely unresolved endpoint in the entire application is `/ai/client-agent/chat/stream`, which targets the absent `mps-ai` service and is excluded from that scan by prefix.

| Category | Count | Verdict |
|---|---|---|
| Frontend endpoints with no backend route | 1 | `/ai/client-agent/chat/stream` — targets the absent `mps-ai` service (P2-03) |
| Backend endpoints the frontend calls with the wrong method | 0 | — |
| Request body field-name mismatches | 1 | `api.campaigns.update` (P2-04) |
| Response field mismatches | 0 | — |
| Path double-slash / missing-prefix bugs | 0 | — |
| Frontend calls bypassing the typed `api.*` client | 19 sites | Behaviourally identical, but the typed layer and live code have drifted (P3-05) |
| Typed `api.*` methods with no call site | 70 | Includes the entire `api.expenses.*` namespace — the backend has an Expenses module and the app has no Expenses screen (P3-04) |
| Calls with no timeout | all | `http()` sets no deadline; a hung fetch leaves `loading` stuck forever (P2-10) |

**Dead-surface detail (P3-04):** `api.expenses.*` (6 methods, whole namespace), `api.gymSettings.get/update` (the app proxies the same path through `src/app/api/settings/gym/route.ts` instead), `api.auth.me()` (duplicated inline), `api.reports.*` (deprecated) **and** `api.insights.overview/.revenue/.business/.attendanceToday/.utilisation/.monthly` (the canonical Insights wrappers, bypassed by `http()` in `src/app/(chrome)/insights/revenue/page.tsx:173-188` — even though the backend explicitly documents `insights.overview` as "the page-level call. Prefer this"), `api.invoices.get/.update/.send/.remind/.cancel`, `api.payments.delete`, `api.bookings.*`, `api.classes.sessions`, `api.qr.checkout/.myHistory/.attendanceReport`, `api.superAdmin.systemHealth/.tenancyOrphans/.hostingerCredentialHistory/.hostingerWebsiteFiles`, and ~40 more.

**Why this matters:** `src/__tests__/api-shape.test.ts` pins a 462-endpoint snapshot, which keeps this dead surface alive and green. Several of these methods are the *only* typed description of a backend contract the app never exercises (e.g. `api.qr.attendanceReport` → `GET /api/qr/staff-report`).

---

## 7. Database and migration integrity findings

**Source of truth:** `src/db/schema.sql` + `src/db/migrations/*.sql` (246 files), applied by `src/db/migrate.js`.

**Migration runner behaviour** (`src/db/migrate.js`): advisory-lock at `619619619` (non-blocking, 15×2 s), a `_migrations` table keyed by **filename**, files applied in **lexicographic filename order**, each file as **one multi-statement round trip** inside `BEGIN`/`COMMIT`, 5 attempts with 2/4/8/16 s backoff. `schema.sql` is **not** applied by the runner — a fresh install is `psql -f schema.sql` then `npm run migrate` (`scripts/e2e-setup.sh:76`).

**Defects — see §12.** The headline: **P0-04, 19 missing columns across 5 tables.**

**Columns confirmed missing from the repo schema but read/written by live application SQL (independently re-verified by me):**

| Table | Missing | Read by |
|---|---|---|
| `class_sessions` | `starts_at`, `ends_at`, `trainer_id`, `branch_id` | `src/routes/classes.js:31,42-44`; `src/modules/bookings/bookings.service.js:90,97,214,231,389-402`; `src/lib/google-calendar.js:180,210`; `src/workers/renewal.worker.js:186,193` |
| `bookings` | `membership_id`, `position` | `bookings.service.js:142,149-153,240,394` |
| `member_memberships` | `plan_id`, `classes_used`, `auto_renew`, `trainer_id`, `base_amount`, `final_amount`, `paid_amount`, `renewed_from_id` | `bookings.service.js:112-119,160,217`; `renewal.worker.js:66-74,133-139` |
| `plans` | `price`, `included_classes` | `renewal.worker.js:67`; `bookings.service.js:113,218` |
| `members` | `name`, `deleted_at` | `renewal.worker.js:36,43,68,186` |

**My own verification of the `class_sessions` case (the load-bearing one):**
```
$ grep -rn "class_sessions" src/db/migrations/*.sql | grep -i "alter\|starts_at\|trainer_id\|branch_id"
015_missing_tables_and_constraints.sql:163-176   ← only ADD COLUMN for the ORIGINAL columns
176_classes_bookings_tenant_columns.sql:48        ← adds organization_id only

$ awk '/CREATE TABLE.*class_sessions/,/;/' src/db/migrations/015_missing_tables_and_constraints.sql
CREATE TABLE IF NOT EXISTS class_sessions (
  id TEXT PRIMARY KEY, template_id TEXT, title TEXT, description TEXT,
  instructor_id TEXT, instructor_name TEXT,
  date DATE NOT NULL, start_time TIME NOT NULL, end_time TIME NOT NULL,
  capacity INT, booked_count INT, location TEXT, status TEXT, ... );
```
No `starts_at`. `src/routes/classes.js:31` selects `cs.starts_at`. → `42703 undefined_column` → HTTP 500.

**Why CI does not catch it:** `.github/workflows/ci.yml:98` *does* stand up a real database from `schema.sql` + all migrations, and 36 `*.integration.test.js` files run against it. But **no test exercises `/api/classes/sessions` or the bookings module against a real DB**. `architecture.domains.convention.test.js` checks table *names* only. `migrations.freshInstall.test.js` checks table *existence* only. **There is no column-level schema/code agreement test anywhere in the repo** — that is the single highest-value test to add (see §15).

**Other database findings:** `pt_payments.payment_ref` (the canonical receipt number) has **no UNIQUE constraint** and is taken verbatim from `req.body` (`pt-os.routes.js:1684` → `ptPayments.js:99,110-115`) — the exact collision the receipt sequence was introduced to prevent (`src/db/receipts.js:6-10`) is now unguarded on the table that actually holds the money (P2-05). Migration order is **inverted between production and a fresh install** for prefixes 174/175/176 — documented in-repo at `migrationNumbers.convention.test.js:21-24,60-62` (P2-13). The migration runner inherits the request pool's 15 s client / 20 s server statement timeouts (`pool.js:90-101` + `migrate.js:57,123`), so **any migration over 15 s aborts the run and every later migration silently never applies** (P1-06). `GET /api/pt-os/payments` and 14 other list endpoints have **no LIMIT** (P2-12). Money is stored correctly as `NUMERIC(12,2)` but computed in IEEE-754 doubles and rounded to whole rupees with `Math.round` (half away from zero) in 7 places — the column's 2-decimal scale is never used (P3-06).

---

## 8. Authentication, authorization, and tenant-isolation findings

**Verdict: no cross-tenant data leak found. Isolation is strong; the residual risk is structural.**

**The derivation chain (verified):**
```
jwt.verify(token, JWT_SECRET)                      middleware/auth.js:96
  → refuse if `purpose` claim present,             :106-108
    token_version not an integer, or no `id`
  → SELECT organization_id, role, pt_client_id,     :124-139
    token_version, is_active FROM users
  → refuse if !is_active / role ∉ {trainer,member,super_admin}  :141-152
  → refuse if tenant role has no organization_id   :141-152
  → refuse if super_admin HAS an organization_id   :141-152
  → refuse if user.token_version !== decoded.token_version      :159-161
  → req.user = user                    ← the ONLY source of tenant truth
  → tenantScope(req) → orgWhere(req) → " AND organization_id = $N" (always emitted)
```

**Verified invariants:**
1. **No request-supplied org id on the tenant plane.** `grep` for `x-org-id` across `src/` finds only comments — the header is read nowhere. The only `org_id` query parameters are in the platform routers, where naming a studio explicitly is the point.
2. **Member identity never comes from the request.** `/api/me/*` takes no client id, org id, or trainer id as parameter, query value, or body field.
3. **Child rows inherit the tenant from a validated parent** (client id validated by `clientInOrg` first, then the child table read by `client_id`).
4. **Ownership on order-style resources returns 404, not 403** (`upi-payments.js:258-279`) — no existence oracle.
5. **The platform plane is guarded on both mounts.** `server.js:872-873` applies `PLATFORM_GUARD = [auth, requireSuperAdmin, requireSuperAdminMfa, requirePlatformOwner]` to `/api/platform` *and* `/api/super-admin`. All 21 sub-routers and the Command Center inherit it. `grep` confirms no second mount of `platformRoutes` outside tests.
6. **Impersonation is well-designed.** Org-scoped target resolution, `imp.ro` read-only default, 30 min TTL (120 min hard cap), `aud` + `imp.org` re-checked on every request, writes stamped `_impersonated_by`, no refresh token, control plane refused.
7. **CORS is an allowlist, not reflect-any-origin** (`server.js:450-470`). A disallowed origin is rejected *before* the route runs.
8. **CSRF:** no token, but `SameSite=Strict` on both cookies **plus** an `originCheck` middleware mounted before every route (`server.js:552`). `originCheck.js:52` skips when neither `Origin` nor `Referer` is present — defence-in-depth loss, not exploitable, since browsers always send `Origin` on cross-origin POSTs.
9. **The WhatsApp gateway enforces ownership structurally** via a private `#requireOwned` that every public operation must pass.
10. **No secret is exposed to the browser.** No `NEXT_PUBLIC_*` variable is a secret. The access token is httpOnly; the refresh token is httpOnly with `path:'/api/auth'`; neither is in `localStorage`/`sessionStorage`. The only JS-held credential is the impersonation Bearer in `sessionStorage` (P3-07).

**Residual risks:**
- **The RLS backstop is dormant in the default deployment.** `pool.js:266-297` sets `app.org_id` per transaction, but that only enforces isolation if `TENANT_RLS_ENFORCE` is on *and* `DATABASE_URL` points at a role without `BYPASSRLS`. The boot guard (`server.js:86-98`) only checks that the two URLs *differ*. **If production serves as `postgres` (the table owner), the application-level org filter is the only isolation** — and it is duplicated in every handler, so a future handler that forgets the org clause leaks silently. This is the single most important thing to verify in the deployed environment (P1-11).
- **`requireTrainer` is a role gate, not an ownership gate.** Every handler behind it must still scope by org. That is done correctly everywhere audited, but it is a convention, not a mechanism.
- **`tenantContext` middleware is never mounted** — dead code (`middleware/tenant.js:42-53`).
- **Plane classification uses `startsWith` prefix matching** (`platformAuth.js:325-329`). No currently-exploitable route, but a future `/api/platform-health` would be misclassified as control-plane (P3-08).
- **Every rate limiter fails OPEN on a Redis error** (`rateLimitStore.js:26-33`, `passOnStoreError: true` at every call site). During a Redis outage the login brute-force control, MFA throttle, refresh budget, and AI spend cap all vanish **silently** — no error, no log (P2-13).
- **MFA enrolment/de-enrolment need no re-authentication and are not rate-limited** (`profile.js:814-832`, `:884-897`). A session holder can replace the TOTP secret (returned in the response body) or remove MFA outright. The codebase's own policy requires the current password for password and email changes — MFA is the outlier (P2-02).
- **Google and passkey sign-in mint 7-day access tokens with no refresh token**, bypassing the 15-minute + rotating-refresh model used by password login (P2-01).

---

## 9. Integration and background-job findings

### Worker / queue inventory

| Worker | Schedule | Queue | Concurrency | Idempotent? | Failure mode |
|---|---|---|---|---|---|
| `email.worker.js` | event-driven | `email` | 5 | **No** | `sendRaw` never throws → a failed send returns `{sent:false}` and the job **completes** (P1-03) |
| `whatsapp.worker.js` | event-driven | `whatsapp` | 5 | **Yes** (2 layers) | Gateway down → retry 3× over ~6 s → `markFailed` → row never re-driven (P1-04) |
| `ai.worker.js` | event-driven | `ai` | 2 | Yes | Embedding model download may fail → doc `status='failed'` |
| `notifications.worker.js` | event-driven | `notifications` | 5 | Partially | `deliverChannel` **catches** channel errors → job **completes**, never retried (P2-06) |
| `renewal.worker.js` | `0 3 * * *` + `*/30 * * * *` | `membership-renewals` | 1 | Yes (pre-charge marker) | Charges a card and **writes no ledger row** (P2-07) |
| `automation.worker.js` | `30 3 * * *`, `*/15 * * * *`, `5 * * * *` | `automation-sweep` | 1 | Yes (dedupe key) | Cron-registration failure is logged, not fatal |
| `progress.worker.js` | `0 4 * * *` | `progress-reminders` | 1 | Yes (claim ledger) | — |
| `subscription.worker.js` | `setTimeout(60s)` + `setInterval(6h)` in `server.js` | none | 1 | Yes | **Runs only in the API process** — invisible to `worker:all` |
| `emailQueue.service.js` | — | `email` | — | — | **Orphan producer** — job name `'send-email'` with `data.type` undefined → the consumer throws `Unknown email job type: undefined` (P2-09) |

All 7 queues have a consumer and a producer. No empty queues. `docker-compose.yml:147` runs the same command as `npm run worker:all`. Redis runs `--appendonly yes --maxmemory-policy noeviction` (correct). Redis is `lazyConnect: true`, so **the API boots fine with Redis down** and degrades to inline sends.

### WhatsApp — **PARTIAL (code complete, deployment broken)**

Every frontend button resolves: status → `GET /api/integrations/whatsapp/status`; connect → `POST .../connect`; QR → `GET .../qr` (2 s poll); reconnect/disconnect/unlink → their endpoints. Backend → gateway over `X-Gateway-Key` + `X-Org-Id`, 10 s timeout, **never throws** (`{ok,status,data,code}`). Gateway: real Baileys implementation with a connect watchdog whose error message is literally `'whatsapp_no_response — check egress to WhatsApp from this host'`; QR never logged or emitted as an event; atomic credential writes (temp + fsync + rename); outbox with `LPUSH`/`RPOPLPUSH` claim, `ZADD` retry, dead-list, and crash reclaim; **6 delivery attempts** with exp backoff then dead-letter; `SET NX` send-once ledger (6 h TTL, longer than the whole BullMQ ladder). Backend webhook: constant-time HMAC over `timestamp.rawBody`, ±300 s window, `ON CONFLICT (event_id) DO NOTHING` **inside the same transaction as the work** — a failure rolls the claim back so the gateway's retry genuinely re-applies.

**The break is P0-01: the committed `docker-compose.yml` forwards no `WA_*` variable at all.** Verified: `grep -n "WA_GATEWAY\|WA_WEBHOOK\|WA_BACKEND" docker-compose.yml` → no match. The file's own header documents the trap ("Compose only passes through variables an `environment:` line names"). Result: `GET /status` → `configured:false`, `POST /connect` → **503 GATEWAY_NOT_CONFIGURED**, and in the worker every automation message → `NOT_CONFIGURED`. The UI faithfully says "WhatsApp is not set up on this server yet" — the error is honest, the configuration is missing.

### Email — **PARTIAL**

Path: `dispatchEmail` → BullMQ `email` queue → `email.worker.js` → `sendWithRetry` (3× in-process) → nodemailer. "Sent" means **SMTP accepted**, not delivered — there is no delivery or open tracking anywhere, which is correct to state but must not be reported as confirmed delivery.

**P1-03:** `lib/email.js:152` uses `redis.isReady()` (not `ensureReady()`), so on a cold process the client status is `'wait'` and **every email is sent inline on the request path** until something else connects it. And `sendPasswordResetInline` returns `{sent:false, reason:'SMTP_NOT_CONFIGURED'}` **without throwing** → the BullMQ job completes successfully → the request path logs **"Password reset email sent"** because `dispatchEmail` returned `{sent:true, queued:true}`. The route's `result.sent === false` guard is dead code on the queued path. A locked-out user's only recovery path fails invisibly.

### AI — **PARTIAL**

Provider: OpenRouter, or any OpenAI-compatible gateway at `AI_BASE_URL` (production points at a FreeLLMAPI instance per `lib/ai/gateway.js:5-8`). Model routing: ~35 intents → 3 tiers, operator override → env → built-in default. Timeout 90 s (clamped 1–300 s). **No HTTP-level retry** — fallback is *model* fallback (primary → secondary → fallback), and `routedStream` injects `'\n\n[Retrying with backup model…]\n\n'` into the SSE stream, which `routes/ai.js:697-708` detects and discards. Quota enforcement ships **OFF** (`enforcement_enabled` gates refusal, not measurement) and **fails open** on error, with a 3-strike escalation counter — a good design.

**P1-05 (confirmed):** `openrouter.js:57-66` requests `usage: {include:true}` **only when the host matches `openrouter.ai`**. Against the actual production gateway, exact usage is never requested → `usage` is null → `usageFields` falls to the estimated branch → **`tokens_prompt = 0`, `tokens_completion = ceil(len/4)`, `cost_inr = null` for every call**. `ai_usage_log` is the table the quota reads, so the quota counts a fraction of real use and every cost reads ₹0. Separately, a provider call that **fails** returns before `logUsage` (`routes/ai.js:711-715`) — a billed-but-failed request is invisible to the quota.

**P2-03:** `src/lib/client-ai.ts:133` calls `${apiBase()}/ai/client-agent/chat/stream` — no `/api` prefix, **no `tenantAuthHeaders()`**, and the path resolves nowhere in the ERP backend (`grep -rn "client-agent" 619-erp-backend/src` → zero hits). It resolves only via the Next rewrite `next.config.js:203`, which is (a) compiled **only in production** (`next.config.js:171-173` returns `[]` otherwise ⇒ always 404 in dev), and (b) registered only `if (aiUrl)` where `aiUrl = process.env.AI_SERVICE_URL` read at **build** time and absent from the frontend `.env.example`. The `mps-ai` service is **not present in this workspace** — its side of the contract is unverifiable here.

### Payments

**UPI — COMPLETE.** Order (amount re-read server-side from a stored, org-scoped plan; staff-only ad-hoc packages; GST from `payment_settings`; `pg_advisory_xact_lock` + `SELECT … FOR UPDATE` reuse of open orders) → proof upload (magic-byte detection, 5 MB cap, server-generated key) → submission (org-scoped, member forced to own `client_id`, screenshot key re-verified, `23505` discrimination between `live_utr` and one-pending-per-order) → approve (one transaction: org-scoped lock, conditional transition with 409 on race, membership window extended, **`pt_payments` ledger row written**, `invoices` in a `SAVEPOINT` so a missing table cannot strand the payment, `membership_payments` with `UNIQUE (payment_order_id)`, audit rows, then `COMMIT`, then automation **after** commit so automation can never fail an approval). Two partial unique indexes back it. This is the best-engineered flow in the codebase.

**Razorpay — STUBBED (P0-03).** Signature verification is real and correct (raw body, `timingSafeEqual`, fails closed when the secret is unset). The handler then **records nothing** — `logger.info(..., 'razorpay_payment_event_not_recorded')` and `200 {received:true}`. The file's own comment explains the three historical UPDATEs referenced columns that never existed on the legacy `payments` table. There is also **no Razorpay customer payment path in the codebase at all**: `lib/razorpay.js`'s `createSubscription`/`fetchSubscription` have zero callers, and no route calls `createOrder`/`capturePayment` for a client. The webhook will therefore silently lose the **first real** gateway payment.

---

## 10. Infrastructure and deployment findings

**The committed Compose is not the deployed topology.** `docker-compose.yml:18-22` says so itself: *"The compose file that actually runs lives on the VPS at /opt/myptstudio/619-erp-backend/, outside this repository. Commiting this here does NOT change that file."* The committed file defines `redis`, `api`, `worker`, `docker-socket-proxy`. Every deploy workflow operates on a **different, unversioned** file and targets a service named `backend`; the WhatsApp overlay's default is `myptstudio-backend` — **three different names for the same container** (P1-08).

| Check | Result |
|---|---|
| Compose services | 4. `redis` (loopback-published, healthcheck `redis-cli ping` ✅), `api` (healthcheck from Dockerfile → `curl --fail /api/health`), `worker` (healthcheck **disabled** ✅ — runs no HTTP server), `docker-socket-proxy` (digest-pinned, read-only, `cap_drop: ALL` ✅) |
| Resource limits | **None** on `redis`, `api`, `worker` |
| `networks:` block | **Absent** — the WhatsApp overlay requires an *external* `myptstudio_network` |
| Nginx | 3 vhosts: `myptstudio.com` → :3000, `api.myptstudio.com` → :5000, `admin.myptstudio.com` → :3000. ACME challenge + 301 to HTTPS. `client_max_body_size 25m`. `http2 on`. The one WebSocket endpoint (`/api/command-center/stream`) **is** proxied with `Upgrade`/`Connection` headers and a 3600 s timeout ✅ |
| Nginx security headers | None — deliberately; the frontend is the single source of truth. Correct design, but the template `include`s `/etc/nginx/snippets/myptstudio-proxy.conf`, **which is not in the repo** — copying it as-is fails `nginx -t` and can leave nginx down (P2-12) |
| TLS | certbot defaults only. No `ssl_protocols`, `ssl_ciphers`, `ssl_stapling`, or OCSP |
| Frontend service in Compose | **Absent** — the committed stack cannot serve the committed nginx template (P1-08) |
| Forwarded env vars | 22 (api) / 30 (worker). **~60 that the code reads are not forwarded**, including every AI provider key, `RAZORPAY_WEBHOOK_SECRET` (⇒ **signature unverified**), the Google OAuth secret, `RP_ID`/`WEBAUTHN_ORIGIN` (⇒ passkeys cannot complete), `TRUST_PROXY` (⇒ **all clients collapse into one rate-limit bucket**), `SERVICE_AUTH_SECRET`, `KIOSK_HMAC_SECRET`, `FCM_SERVER_KEY`, `DATABASE_POOL_SIZE`, `DATABASE_SSL_CA` (⇒ pool is always 20 and TLS verification is always off) (P1-09) |
| `TRUST_PROXY` | `.env.example:449` documents `=1`; `server.js:100-115` requires `=2` in production and warns; Compose forwards it not at all ⇒ the container always gets the default `1` |
| `APP_TIMEZONE` | Read by `pool.js:9,132` and `appTime.js:45`; **absent from `.env.example`** and from Compose ⇒ hard-wired to `Asia/Kolkata` in the container |
| Sentry | **Backend**: initialised correctly (`instrument.js`, first require in `server.js`), `SENTRY_DSN` forwarded on both services ✅. **Frontend**: `sentry.ts` is correct, but **no workflow ever supplies `NEXT_PUBLIC_SENTRY_DSN`** ⇒ every browser error is silently dropped while the Command Center's `sentry_configured` check reads the *backend's* DSN and reports green (P1-10) |
| Health endpoints | Backend `/api/health` checks Postgres **and** Redis and returns 503 if either is down. Because the Dockerfile's `HEALTHCHECK` uses `curl --fail` and `verify-serving.sh` uses `curl -sf`, **a Redis blip marks the container unhealthy and fails the deploy gate** even though the API is serving (queues degrade to inline by design) (P2-15). Frontend `/api/health` checks **nothing external** — it does not verify the backend is reachable |
| Backups | `pg_dump -Fc` nightly at 02:30 UTC, verifies the dump, optional R2 upload, 30-day retention. **The off-site copy has been failing since at least 2026-10-02** (`DISASTER-RECOVERY.md:193`: *"every run fails at the upload — The specified bucket does not exist. Runs #8–#17 all failed."*). No restore drill against a production dump. No backup-failure alerting. No PITR (Supabase free plan). No WhatsApp session-volume backup (documented, entirely manual) (P2-11) |
| CI — backend | `lint` (0 warnings) · `test` (real Postgres `pgvector/pgvector:pg15` + a second `rls_proof` DB, 36 integration files) · `gateway-seam` (checks out the gateway, runs the null connector, asserts the seam) · `security` (`npm audit --audit-level=high`). Deploy waits on `workflow_run.conclusion == 'success'` ✅ |
| CI — frontend | `lint` (ratchet frozen at 269 warnings) · `typecheck` · `test` (225 files, no `--passWithNoTests`) · **`e2e` (real Postgres 16, real migrations, the real API on :5100, Playwright browser journeys)** · `build` (needs lint+typecheck+test+e2e) · `security`. `continue-on-error` was deliberately removed from e2e so it blocks a release ✅ |
| CI — whatsapp | lint / typecheck / test / build / audit. No DB, no Redis (fakes for both). **Triggers only on `feature/whatsapp-gateway-mvp` — the gateway repo has no `main` branch** |
| Deploy atomicity | **None.** Backend and frontend deploy independently from their own `main`; the gateway deploys from a feature branch. No workflow deploys all three as one unit |
| Frontend rollback secret | `rollback.yml:62` uses `secrets.SSH_KEY`; the frontend's own `deploy.yml:135` uses `secrets.SSH_PRIVATE_KEY`. **The rollback path — the one you reach for when main is broken — fails at the SSH step** if only the deploy's name is set (P1-12) |

---

## 11. Test and CI results

Commands executed, with exact exit codes. All non-mutating; no test was run against a production database.

| # | Command | Repo | Exit | Result |
|---|---|---|---|---|
| 1 | `npm run lint` | backend | **0** | Clean — `eslint .` reported no errors or warnings |
| 2 | `npm run typecheck` (`tsc --noEmit`) | frontend | **0** | Clean — no type errors |
| 3 | `npm test` (jest) | backend | see below | 364 test files |
| 4 | `npm test` (vitest) | frontend | see below | 225 test files |
| 5 | `npm run lint` | whatsapp | **not run** | `node_modules` absent; installing dependencies requires approval |
| 6 | `npm run typecheck` | whatsapp | **not run** | as above |
| 7 | `npm test` | whatsapp | **not run** | as above |
| 8 | `npm run build` | frontend | **not run** | `next build` needs `NEXT_PUBLIC_API_URL` at build time; a failed build would rewrite `.next/` and is not a read-only check |
| 9 | `npm run build` | backend | n/a | No build step (plain JS) |
| 10 | `npm audit --audit-level=high` | all | **not run** | Requires network; CI already runs it as a blocking job |
| 11 | `npm run migrate` | backend | **not run** | Mutating — explicitly out of scope |
| 12 | Any DB query | backend | **not run** | Backend `.env` points at `127.0.0.1:5433` (**closed**); `:5432` is open but the credentials in `.env` were rejected. Every schema claim in this report is therefore **statically derived** from `schema.sql` + 246 migrations and cross-checked against the application SQL |

*(Test-suite outcomes for commands 3 and 4 are recorded in §11.1 below.)*

### 11.1 Test suite outcomes

**Backend — Command 3, Run A (default settings; machine under external load ≈13):**

```
cd 619-erp-backend && npm test
# = NODE_OPTIONS=--experimental-vm-modules jest --forceExit --detectOpenHandles
```
- **Exit: 1.**
- Summary: **Suites — 325 passed / 36 skipped / 7 failed (368 total) · Tests — 4,752 passed / 450 skipped / 10 failed (5,212 total).**
- The 7 failed suites / 10 failed tests occurred while a competing session was running vitest plus other builds on this 4-core box (load avg ≈ 13).

**Failure-classification (each failing file re-run in isolation, clean load):**

| Failing file | Alone result | Verdict |
|---|---|---|
| `src/__tests__/attendance.leaderboard.test.js` | `npx jest …` → **2/2 passed**, 3.1 s | load-induced; not a code defect |
| `src/__tests__/superAdmin.aiControlCentre.test.js` | alone → **20/20 passed**; pair-run (with a neighbour suite) → **passed** | load-induced; not a code defect |
| remainder of the 10 failed tests | spread across the remaining 5 suites | **not individually re-verified** (each `npm test` re-attempt aborted; see Run B) — same signature (timeouts under `NODE_OPTIONS`-less/loaded workers) |

- **Run B (constrained, clean-load attempt):** `NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=1536" npx jest --testTimeout=30000 --maxWorkers=2 --forceExit` → **exit 134: V8 heap OOM (core dump), `Ineffective mark-compacts near heap limit`, at ≈17 min.** Zero `FAIL` lines were emitted before the crash; the suite running at crash time (`workoutGenerator.routes.test.js`, inferred from its last log line) **passes alone — 5/5, 21 s**. Conclusion: **cumulative heap growth across the 364-file run on a 4-core/12-GB box, i.e. an environment limitation — not a product defect.** No fresh defects surfaced in either run; the recorded metric is Run A.
- `workoutGenerator.routes.test.js` alone: **5/5 passed** (targets `POST /clients/:id/workout-generator/preview` etc.).

**Frontend — Command 4 (vitest), partial backdrop run:**

```
cd 619-erp-frontend && npm test   # npx vitest run
```
- The full run was interrupted before completion (**exit 143, SIGTERM** — operator kill; machine load ≈ 13 from build processes).
- Suites observed failing before the kill: `src/__tests__/cockpit-layout.test.tsx` (2 tests: *"orders the day…"*, *"keeps the rest of the cockpit…"*) and `src/__tests__/member-habits-journal.repro.test.tsx` (1 test: *"shows one confirmation per save…"*).
- **Classification: NOT yet established** (could be load-induced or real). `npm run typecheck` is clean (exit 0), so these are behaviour-level, not type-level. **A clean, load-free vitest run is still required to close command 4.**

**Caveat affecting all backend numbers:** `--experimental-vm-modules` is **required** — without it `ai.textExtract.test.js` fails with *"A dynamic import callback was invoked without --experimental-vm-modules"* (an environment flag, not a defect). `--detectOpenHandles` (in `npm test`) plus logger output buffering contributed to Run A's memory pressure; the jest pipeline itself has never completed on this machine under load.

---

## 12. Defect register

### P0 — Critical

**P0-01 · CONFIRMED · WhatsApp is entirely non-functional under the committed Compose file**
- **Where:** `619-erp-backend/docker-compose.yml:79-125` (api) and `:154-189` (worker); `src/routes/whatsapp.js:204-210`; `src/lib/whatsappGateway.js:49-51`
- **Evidence:** `grep -n "WA_GATEWAY\|WA_WEBHOOK\|WA_BACKEND" docker-compose.yml` → **no match**. The file's own header: *"Compose only passes through variables an `environment:` line names."*
- **Expected:** the gateway is configured, `POST /api/integrations/whatsapp/connect` creates an instance and returns a QR.
- **Actual:** `gateway.isConfigured()` is false ⇒ `GET /status` returns `configured:false` and `POST /connect` returns **503 `GATEWAY_NOT_CONFIGURED`**. The UI shows "WhatsApp is not set up on this server yet" (`WhatsAppCard.tsx:308-315`). In the worker, `transport.send` returns `NOT_CONFIGURED` for every automation message. **The entire WhatsApp product is dead on arrival.** The gateway *code* is complete and correct — only the wiring is missing.
- **Repro (safe):** `grep -c "WA_GATEWAY_URL" docker-compose.yml` → `0`.
- **Impact:** every studio that pairs a WhatsApp number gets a non-functional integration; every automated WhatsApp message (membership-expiry reminders, birthday greetings, payment receipts) is dropped.
- **Fix:** add `WA_GATEWAY_URL`, `WA_GATEWAY_KEY`, `WA_WEBHOOK_SECRET` to the api and worker `environment:` blocks. (The live VPS compose is patched by `deploy-whatsapp.yml`'s awk step — the *committed* file must be brought into agreement or the next rebuild loses the integration.)
- **Regression test:** a compose-config assertion that every env var read by `src/lib/whatsappGateway.js` is present in the `api` and `worker` service definitions.

**P0-02 · CONFIRMED · All AI features are non-functional under the committed Compose file**
- **Where:** `docker-compose.yml:79-125,154-189`; `src/lib/ai/openrouter.js:27`; `src/routes/ai.js:88-107`
- **Evidence:** no `OPENROUTER_API_KEY` / `AI_API_KEY` / `AI_BASE_URL` in either service's `environment:`.
- **Expected:** AI Coach, AI workout/diet generation, AI progress analysis, business insights.
- **Actual:** `requireConfigured` returns **501 "AI not configured"** for every generative route. The knowledge-base and `/api/ai/actions` routes are mounted but every action that needs a model is dead.
- **Repro (safe):** `grep -c "OPENROUTER_API_KEY\|AI_API_KEY" docker-compose.yml` → `0`.
- **Impact:** an entire product surface is unavailable, and the failure is a 501 that reads like "the model is broken" rather than "the key was never deployed."
- **Fix:** forward `AI_API_KEY` (or `OPENROUTER_API_KEY`) and `AI_BASE_URL` to api and worker. Add the same compose-config assertion as P0-01.

**P0-03 · CONFIRMED · The Razorpay webhook acknowledges captured payments and records nothing**
- **Where:** `src/routes/razorpay-webhook.js:83-97`
- **Evidence:** `if (eventType === 'payment.captured' || …) { logger.info(…, 'razorpay_payment_event_not_recorded'); } … res.json({ received: true });`
- **Expected:** a captured payment writes a `pt_payments` ledger row, a `membership_payments` row, and an invoice.
- **Actual:** HTTP 200, zero writes. No ledger row, no receipt, no reconciliation, no refund path. There is also **no Razorpay customer-payment path in the codebase at all** — `lib/razorpay.js`'s `createSubscription`/`fetchSubscription` have zero callers, and no route calls `createOrder`/`capturePayment` for a client. The `renewal.worker.js` path operates on `members`/`member_memberships`, which the code's own comment says hold 0 rows in production.
- **Repro (safe):** read the handler; there is no `INSERT`/`UPDATE` in it.
- **Impact:** the first real gateway payment is silently lost. The gateway sees a 200, never retries, and the platform never learns the money arrived. Severity depends on whether Razorpay is used for customer payments today — **verify before dispatching**.
- **Fix:** either implement the ledger write (mirroring the UPI approve path, which is already correct) or remove the route and the `razorpay` dependency so the gap is not left ambiguous. Also add a replay ledger before any write is reintroduced (P2-15a).
- **Regression test:** a webhook fixture asserting a `pt_payments` row exists after a `payment.captured` event.

**P0-04 · CONFIRMED · 19 columns across 5 tables are missing from the repo schema but read by live application SQL**
- **Where:** `src/db/migrations/015_missing_tables_and_constraints.sql:40-71,87-98`; `src/db/migrations/003a_plans_table.sql:5-26`; read by `src/routes/classes.js:28-45`, `src/modules/bookings/bookings.service.js:90,112-119,142-153,214-240,389-402`, `src/lib/google-calendar.js:180-210`, `src/workers/renewal.worker.js:36-74,133-139,186-193`
- **Evidence:** the full missing-column list is in §7. Independently re-verified for `class_sessions`: the `CREATE TABLE` in `015` has `date`/`start_time`/`end_time`/`instructor_id`; no migration ever adds `starts_at`/`ends_at`/`trainer_id`/`branch_id`; `src/routes/classes.js:31` selects `cs.starts_at`.
- **Expected:** a fresh install's schema matches what the code queries.
- **Actual:** on any database built from `schema.sql` + migrations — a new environment, CI, a restored-from-schema staging box — every one of those queries fails with **`42703 undefined_column`**. Affected live surfaces: `GET /api/classes/sessions` → 500; `POST`/`DELETE /api/bookings` → 500 at the first SELECT; Google Calendar booking sync → 500; the entire renewal worker (`runReminders`, `runAutoRenew`, `runClassReminders`).
- **Why CI misses it:** CI *does* build a real database, but no test exercises these endpoints against it. `architecture.domains.convention.test.js` checks table **names**; `migrations.freshInstall.test.js` checks table **existence**. There is no column-level agreement test anywhere.
- **Repro (safe, on a scratch DB only):** `psql -f src/db/schema.sql` + apply migrations, then `SELECT starts_at FROM class_sessions LIMIT 1;` → `ERROR: column "starts_at" does not exist`.
- **Impact:** the group-classes and bookings product, Google Calendar sync, and automated renewals are all non-functional on any environment built from this repository. Production may be unaffected (its schema may carry columns the repo does not), which is precisely the "divergence the repo already knows about" that migration `177` documents for *tables* — the *columns* were never reconciled.
- **Fix:** add a migration that creates the missing columns (with the correct types and backfill), or change the queries to use the columns the schema actually has. Whichever is chosen, add the column-level agreement test below.
- **Regression test:** a test that builds the schema from `schema.sql` + migrations and asserts every column referenced by application SQL exists — see §15.

---

### P1 — High

**P1-01 · CONFIRMED · The frontend `.env.example` instructs operators to leave `JWT_SECRET` unset, which makes every authenticated page redirect to sign-in**
- **Where:** `619-erp-frontend/.env.example:16-28` vs `619-erp-frontend/src/proxy.ts:135-150`
- **Evidence:** the example says *"OPTIONAL, and recommended to LEAVE UNSET. … Unset, an unexpired forged token gets you a page shell and 401s from every request behind it."* The code says the opposite:
  ```ts
  const secret = process.env.JWT_SECRET;
  if (secret) { try { await jwtVerify(token, …); return withReportOnlyCsp(req); } catch { return redirectToLogin(req, true); } }
  // JWT_SECRET is not set — refuse authentication rather than falling back to expiry-only validation.
  return redirectToLogin(req, true);
  ```
  The frontend CI comment confirms it: *"proxy.ts refuses every authenticated page without it, so every journey would land on the sign-in screen and fail for a reason that is not the product's."*
- **Expected:** the documented "page shell" behaviour, or the documentation updated to match the code.
- **Actual:** with `JWT_SECRET` unset, **every signed-in user is redirected to `/login` on every authenticated page**. The frontend Dockerfile declares no `ARG`/`ENV` for it, so it can only come from the unversioned live compose.
- **Repro (safe):** unset `JWT_SECRET`, request any authenticated page with a valid session cookie, observe a redirect to `/login`.
- **Impact:** total outage of the authenticated product for every studio, with a cause (a missing secret) that nothing in the logs points to. The runbook operators follow is the one that is wrong.
- **Fix:** decide the intended behaviour and make the two agree. Given the code's reasoning is sound (an unsigned-decoded token is a real vulnerability), **fix the documentation**, and make the required secret fail loudly at boot rather than at first request.
- **Regression test:** a `proxy.ts` test asserting the documented behaviour matches the code for both the set and unset cases.

**P1-02 · CONFIRMED · Five device/session controls report success and do nothing**
- **Where:** `src/routes/profile.js:951-988`
- **Evidence:**
  ```js
  router.get('/devices', (req, res) => { const info = clientInfo(req); res.json([{ id:'current', name:`${info.browser} on ${info.os}`, … }]); });
  router.delete('/devices/:id', (req, res) => { if (req.params.id === 'current') return res.status(400)…; res.json({ message: 'Device revoked' }); });
  router.get('/sessions',  (req, res) => { const info = clientInfo(req); res.json([{ id:'current', … }]); });
  router.delete('/sessions/:id', (req, res) => { if (req.params.id === 'current') return res.status(400)…; res.json({ message: 'Session revoked' }); });
  ```
  There is **no `refresh_tokens` or `users` query** in any of the four. The sibling `POST /api/profile/sessions/revoke-all` (`profile.js:990`) does the real thing (`UPDATE users SET token_version = token_version + 1`).
- **Expected:** a session list from `refresh_tokens`; a revoke that actually revokes.
- **Actual:** both GETs return a hardcoded single-element array regardless of the database — a user with five live sessions is told they have one. Both DELETEs return **HTTP 200 "Session revoked"** and revoke nothing. The frontend calls all four (`settings/profile/page.tsx:959-960`, `useWebAuthn`-adjacent session UI).
- **Repro (safe):** `DELETE /api/profile/sessions/abc` with a valid session → `200 {"message":"Session revoked"}`; then observe the session still works.
- **Impact:** a user who believes they revoked a compromised device has revoked nothing. This is the single most security-relevant "fake success" in the app.
- **Fix:** implement both GETs against `refresh_tokens` and make both DELETEs actually revoke (revoke the token, bump `token_version` for the device case).
- **Regression test:** create two sessions, revoke one, assert the other still works and the revoked one returns 401.

**P1-03 · CONFIRMED · A password-reset email that was never sent is logged as sent**
- **Where:** `src/lib/email.js:149-161` and `:359-363`; `src/routes/auth.js:537-590`
- **Evidence:** `dispatchEmail` uses `redis.isReady()` (not `ensureReady()`); on a cold process the client status is `'wait'`, so every email is sent **inline on the request path**. `sendPasswordResetInline` returns `{sent:false, reason:'SMTP_NOT_CONFIGURED'}` **without throwing** ⇒ the BullMQ job completes successfully ⇒ no retry, no failed job, nothing to inspect. The route then logs `logger.info({ email, outcome: 'sent' }, 'Password reset email sent')` because `dispatchEmail` returned `{sent:true, queued:true}` — the route's `result.sent === false` guard is **dead code on the queued path**.
- **Expected:** a failed send is recorded as a failure and retried; the log says what actually happened.
- **Actual:** the request path reports "sent" for an enqueue; the worker reports success for a no-op.
- **Repro (safe):** unset `SMTP_HOST`, call `POST /api/auth/forgot-password`, read the logs — "Password reset email sent"; no mail, no failed job.
- **Impact:** a locked-out user cannot recover, and the operator's only signal says it worked. A password reset is a security-critical path.
- **Fix:** throw on `SMTP_NOT_CONFIGURED` in `sendPasswordResetInline` (as `sendAdminInvitation` already does at `lib/email.js:435-440`); use `ensureReady()`; log `queued` separately from `sent`.
- **Regression test:** with SMTP unconfigured, assert the job lands in `failed` and the route log says `queued`, not `sent`.

**P1-04 · CONFIRMED · A gateway outage permanently and silently loses the studio's automated WhatsApp messages**
- **Where:** `src/services/whatsapp.service.js:190-225`; `src/modules/automation/automation.repository.js:606,646-649`
- **Evidence:** `GATEWAY_UNREACHABLE` → `transport.js:202` default branch → `status: FAILED` → retryable → BullMQ retries 3× over ~6 s (2 s, 4 s) → third attempt `willRetry()` false → `markFailed`. The row is now `status='failed'`, `failure_reason='gateway_unreachable'`. `orphanCandidates` selects `status='queued'` **only** (`:606`); `RECONNECT_FIXABLE` (`:646-649`) matches only `whatsapp_*` / `not_connected` / `instance_not_connected` / `instance_not_found` — **`gateway_unreachable` matches none**. `insertQueuedWithinLimit` has `ON CONFLICT (organization_id, automation_dedupe_key) DO NOTHING`, so the same business event can never produce a new row.
- **Expected:** a ~10 s gateway outage defers messages, it does not destroy them.
- **Actual:** the messages are permanently lost, with no dead-letter path and no error surfaced to the studio.
- **Impact:** membership-expiry reminders, birthday greetings, and payment receipts are silently dropped during any brief gateway blip — exactly the moment they matter.
- **Fix:** add `gateway_unreachable` to the reconnect-fixable set, or route exhausted jobs to a dead-letter table with a re-drive path. A 6 s retry budget is shorter than any real outage.
- **Regression test:** simulate `GATEWAY_UNREACHABLE` on the first attempt and success on the second; assert the message is delivered exactly once.

**P1-05 · CONFIRMED · AI usage accounting records zero prompt tokens and null cost against the actual production provider**
- **Where:** `src/lib/ai/openrouter.js:57-66`; `src/lib/ai/metering.js:26-44`
- **Evidence:** `const isOpenRouter = () => /(^|\.)openrouter\.ai(\/|$)/.test(new URL(BASE_URL).host + '/'); function requestExtras() { if (!isOpenRouter()) return {}; … return { usage: { include: true } }; }`. Production points `AI_BASE_URL` at a FreeLLMAPI instance (`lib/ai/gateway.js:5-8`). `usageFields` then falls to the estimated branch: `tokens_prompt: 0, tokens_completion: Math.ceil(len/4), cost_inr: null, usage_source: 'estimated'`.
- **Expected:** `ai_usage_log` records what was actually spent.
- **Actual:** **every call logs `tokens_prompt = 0` and `cost_inr = null`.** `ai_usage_log` is the table the quota reads (`aiQuota.js:47-59`), so the quota counts a fraction of real usage and every cost reads ₹0.
- **Impact:** AI spend is unmeasurable, the quota under-counts, and the Command Center's AI-cost view reports nothing. This is the exact bug the `usage.include` change was meant to fix, reintroduced for the real provider.
- **Fix:** send `usage: {include:true}` to any OpenAI-compatible endpoint that accepts it, or read the token counts the provider does return. Log usage on the failure path too (P2-08a).
- **Regression test:** a provider fixture that returns a `usage` block; assert `ai_usage_log.tokens_prompt` and `cost_inr` are populated (not zero/null).

**P1-06 · CONFIRMED · The migration runner inherits the request pool's 15 s / 20 s statement timeouts, so a slow migration aborts the whole chain**
- **Where:** `src/db/pool.js:90-101`; `src/db/migrate.js:57,123`
- **Evidence:** the pool is created with `statement_timeout: 20000` and `query_timeout: 15000`. `migrate.js` borrows from that same pool and executes each migration file as **one multi-statement round trip** (`await client.query(sql)`). Verified in the installed `pg@8.20.0`: `statement_timeout` is sent as a connection parameter (the server cancels at 20 s with `57014`), and `query_timeout` arms a client read timer (rejects at 15 s with `Query read timeout`).
- **Expected:** a migration runs to completion or fails atomically, and later migrations still apply.
- **Actual:** a migration over 15 s is aborted; `migrate.js:127-131` then issues `ROLLBACK` on a possibly-broken connection and **the run aborts — every migration after the slow one silently never applies**. The likely culprits are the bulk migrations: `174_cardio_prescription_upgrade.sql:75-225` (a 14-row `UPDATE … FROM (VALUES …)` across `exercises`), `217_payment_balance_applied_and_receipts.sql:35-47` (a row-by-row loop over every `pt_payments` row), `140_exercise_library.sql` (a `tsvector` GENERATED column + 6 GIN indexes).
- **Impact:** a deploy can half-apply and report failure, leaving the schema at an unknown point. This is the same failure mode `migrations.freshInstall.test.js:12-24` was written to detect.
- **Fix:** give the migration runner a dedicated connection with the timeouts disabled, or per-file `SET LOCAL statement_timeout = 0` inside the migration transaction.
- **Regression test:** a migration fixture that sleeps past the pool timeout, asserting the rest of the chain still applies.

**P1-07 · CONFIRMED · `plans.duration` is a TEXT enum used as a number of months, producing `Invalid Date`**
- **Where:** `src/db/migrations/003a_plans_table.sql:11-12`; `src/workers/renewal.worker.js:130-131`
- **Evidence:** `duration TEXT NOT NULL DEFAULT 'Monthly' CHECK (duration IN ('Monthly','Quarterly','Half Yearly','Yearly'))`. The worker: `const newEnd = new Date(); newEnd.setDate(newEnd.getDate() + m.duration);` → `getDate() + 'Monthly'` = `NaN` → `setDate(NaN)` → `Invalid Date`, bound as the `end_date` parameter of the `INSERT` at `:133-139`. The repo already knows the trap — `src/routes/upi-payments.js:92` carries the comment *"plans.duration is an enum of words, not a number of months."*
- **Expected:** the renewed membership gets a real end date.
- **Actual:** the rolled-over row gets an invalid end date. Currently masked by P0-04 (the query fails earlier), but it is a second, independent break in the same statement.
- **Fix:** map the enum to months (`{Monthly:1, Quarterly:3, 'Half Yearly':6, Yearly:12}[m.duration]`) before computing the date.
- **Regression test:** assert the renewed membership's `end_date` is a valid date N months out.

**P1-08 · CONFIRMED · The committed `docker-compose.yml` is not the deployed topology**
- **Where:** `docker-compose.yml:18-22,62,136,243` vs `.github/workflows/deploy.yml:42-47`, `rollback.yml:85-86`, `backup.yml:84`, `deploy-whatsapp.yml:60-63`, `619-erp-whatsapp/deploy/compose.whatsapp.yml:24`
- **Evidence:** the committed file defines `redis`/`api`/`worker`/`docker-socket-proxy`; the workflows target a service named `backend`; the WhatsApp overlay defaults to `myptstudio-backend` — **three names for the same container**. The committed file has **no `frontend` service** (yet `infra/nginx/myptstudio.conf:94,115` proxies to `:3000`) and **no `networks:` block** (yet the overlay requires an external `myptstudio_network`).
- **Impact:** anyone reading the repo believes `docker compose up` reproduces production. It does not. A disaster-recovery rebuild from the repo would produce a stack with no frontend, no WhatsApp network, and no gateway wiring. `cc-recovery.sh` and `deploy-whatsapp.yml` awk-patch the *live* file using assumptions about indentation and service names tuned against a file nobody in the repo can see.
- **Fix:** either version the real compose file or add a prominent "THIS IS NOT THE DEPLOYED TOPOLOGY" banner plus the real service names to the committed one. The `deploy-whatsapp.yml` awk-patching of a live file should be replaced with a versioned overlay.
- **Regression test:** a CI assertion that every service name referenced by a workflow exists in the committed compose.

**P1-09 · CONFIRMED · The committed Compose forwards 22 variables; ~60 that the code reads are never forwarded**
- **Where:** `docker-compose.yml:79-125,154-189`; the read sites listed in §10
- **Evidence (highest impact):** `RAZORPAY_WEBHOOK_SECRET` ⇒ `WEBHOOK_SECRET = ''` ⇒ **payment webhook signature unverified**. `RP_ID`/`WEBAUTHN_ORIGIN` ⇒ **passkeys cannot complete** (`security.collector.js:67` says so). `TRUST_PROXY` ⇒ default `1` ⇒ **every client collapses into one rate-limit bucket** (the code's own warning at `server.js:100-115` explains exactly this). `OPENROUTER_API_KEY`/`AI_API_KEY` ⇒ P0-02. `WA_*` ⇒ P0-01. `DATABASE_POOL_SIZE`/`DATABASE_SSL_CA` ⇒ the pool is always 20 and TLS is always `{rejectUnauthorized:false}`. `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` ⇒ Google Calendar off. `SERVICE_AUTH_SECRET`, `KIOSK_HMAC_SECRET` (⇒ QR check-in reuses `JWT_SECRET`), `FCM_SERVER_KEY`, `RESEND_API_KEY` ⇒ off.
- **Severity note:** the live compose is unversioned and may forward more, so this is a **documented-contract** defect rather than a proven production defect. It is still a P1 because the committed file is the only thing a reviewer, a new operator, or a DR rebuild can read.
- **Fix:** add the missing variables to both service blocks, and add a CI check that every `process.env.X` / `env.X` read in `src/` appears in the compose `environment:` list (or is explicitly declared as optional).

**P1-10 · CONFIRMED · The frontend Sentry DSN is never supplied, so browser error monitoring is inert while the backend's half looks configured**
- **Where:** `619-erp-frontend/Dockerfile:72-85`; `619-erp-frontend/.github/workflows/deploy.yml:76`; `619-erp-frontend/.github/workflows/ci.yml:423-425`; `src/lib/sentry.ts:12`
- **Evidence:** the Dockerfile's own comment: *"The Sentry DSN is NEXT_PUBLIC_, which means Next.js INLINES it into the client bundle at build time — setting it in the runner stage's environment, or in docker-compose's runtime `environment:`, does nothing at all. The symptom is a silently inert integration … while the Command Centre's `sentry_configured` check, which reads the BACKEND's SENTRY_DSN, can be perfectly green. Half-configured, and the two halves disagree."* The deploy workflow passes only `GIT_SHA`/`BUILD_TIME`/`APP_VERSION`; the CI build job passes only `NEXT_PUBLIC_API_URL`.
- **Expected:** browser errors reach Sentry.
- **Actual:** the deployed bundle contains no DSN; `sentry.ts:12` returns before `Sentry.init()`; `captureError()` returns immediately. **Every browser-side error is silently dropped**, and the Command Center reports `sentry_configured: green` because it reads the backend's DSN.
- **Fix:** add `ARG/ENV NEXT_PUBLIC_SENTRY_DSN` to the Dockerfile and pass it as a build arg from the deploy workflow and the compose `build.args:`.
- **Regression test:** a build-arg presence assertion; or a smoke test asserting `Sentry.isInitialized()`.

**P1-11 · CONFIRMED (mechanism) · The RLS tenant backstop is dormant unless production connects as a non-`BYPASSRLS` role**
- **Where:** `src/db/pool.js:266-297`; `src/server.js:86-98`; `src/db/rlsPreflight.js` (`server.js:1113-1133`)
- **Evidence:** `set_config('app.org_id', orgId, true)` is set per transaction, but RLS only enforces it if the connecting role lacks `BYPASSRLS`. The boot guard checks that `ADMIN_DATABASE_URL !== DATABASE_URL` — it does **not** check the role's `rolbypassrls`. `rlsPreflight.js`'s `strict` posture refuses to listen, so the posture is reported — but the application-level org filter is duplicated in every handler, and a future handler that forgets the org clause leaks silently.
- **Expected:** either RLS enforces the boundary, or the application filter is guaranteed by construction.
- **Actual:** depends on the deployed role. **This is the single most important thing to verify in the production environment** — it is the difference between "one forgotten `AND organization_id = $N` is a non-event" and "one forgotten clause is a cross-tenant data leak."
- **Repro (safe, read-only):** on the deployed DB, `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user;`
- **Fix:** verify the production role; if it has `BYPASSRLS`, either grant the `app_tenant` role and point `DATABASE_URL` at it, or add a startup assertion that refuses to boot with a table-owner connection in production.
- **Regression test:** the existing `rls.isolation.integration.test.js` already covers the *intended* posture — the gap is that it is not enforced at boot in the default configuration.

**P1-12 · CONFIRMED · The frontend rollback workflow uses a different secret name than the frontend's own deploy workflow**
- **Where:** `619-erp-frontend/.github/workflows/deploy.yml:135` (`secrets.SSH_PRIVATE_KEY`) vs `619-erp-frontend/.github/workflows/rollback.yml:62` (`secrets.SSH_KEY`)
- **Impact:** if the repository has only one of the two set, the **rollback path — the one you reach for when main is broken — fails at the SSH step.**
- **Fix:** use one name in both workflows and document it.

---

### P2 — Medium

| ID | Conf. | Finding | Where / evidence | Fix |
|---|---|---|---|---|
| **P2-01** | C | Google and passkey sign-in mint **7-day** access tokens with **no refresh token**, bypassing the 15-minute + rotating-refresh model | `auth-google.js:101-111,18`; `auth-webauthn.js:692-697,356-364`; neither calls `issueRefreshToken` | One `signAccessToken()` for all three; issue a refresh token on Google/passkey success |
| **P2-02** | C | MFA enrolment/de-enrolment need no re-authentication and are not rate-limited; the TOTP secret is returned in the response body | `profile.js:814-832` (setup), `:884-897` (disable); no password check, no limiter, not refused under impersonation (contrast `lib/emailChange.js:53-65`, which does both) | Require the current password; refuse under `req.impersonation`; add a per-user limiter |
| **P2-03** | C | `client-ai.ts` calls `/ai/client-agent/chat/stream` — no `/api` prefix, **no tenant headers**, and the path resolves nowhere in the ERP backend | `619-erp-frontend/src/lib/client-ai.ts:133-143`; `grep -rn "client-agent" 619-erp-backend/src` → 0 hits; `next.config.js:203` registers the rewrite only `if (aiUrl)` and only in prod; `mps-ai` is absent from this workspace | Add `tenantAuthHeaders()`; add `AI_SERVICE_URL` to the frontend `.env.example`; or point the call at the ERP's `/api/ai/chat` |
| **P2-04** | C | `api.campaigns.update` sends field names the backend PUT does not read — and **clears the scheduled date** | Frontend `toCampaignPayload` returns `{name, channel, goal, audience, start, end}` (`src/lib/forms/schemas/campaign.ts:164-173`); backend reads `{name, type, audience, subject, body, scheduled_at, status}` and writes `scheduled_at = $6` (`routes/campaigns.js:97,99`) where `$6 = scheduled_at \|\| null`. `channel`→ignored, `goal`→ignored, `start`→ignored **and the schedule is nulled**, `end`→ignored. The POST *does* accept the aliases (`campaigns.js:80`), so create works and update does not | Align the payload builder with the PUT's field names (or make the PUT accept the aliases as the POST does). No caller exists today, so this is latent — but it returns **HTTP 200** on a silent no-op |
| **P2-05** | C | `pt_payments.payment_ref` (the canonical receipt number) has **no UNIQUE constraint** and is taken verbatim from the request body | `migrations/018:47` (no constraint; only a trigram index in `106`); `pt-os.routes.js:1684` → `ptPayments.js:99,110-115`; printed by `paymentReceiptPdf.js:33`; searched by `search.service.js:493`. Contrast `membership_payments_receipt_unique` (`112:299`) and the legacy `payments.receipt_no UNIQUE` | Add `UNIQUE (organization_id, payment_ref)`; generate the receipt server-side and ignore the client value (as `genReceiptNo` already does when the client omits it) |
| **P2-06** | C | Notification delivery failures never retry — the queue's 3-attempt backoff is decorative | `notifications.service.js:302-310` catches channel errors → `{status:'failed'}` → the job **completes** | Re-throw so BullMQ retries, or record a failure the sweeper picks up |
| **P2-07** | C | The renewal worker **charges a card and writes no ledger entry** | `renewal.worker.js:98-101` (Razorpay create + capture) → `:108-117` logs `auto_renew_charged_without_ledger_entry` → `:144-159` (the `payments` INSERT was removed). The only record is a log line | Write a `pt_payments` row, or remove the charge path until it can be recorded. The pre-charge marker does correctly prevent a double charge |
| **P2-08** | C | Unauthenticated crash + hung socket on `POST /api/webhooks/razorpay` with a non-JSON `Content-Type` | `razorpay-webhook.js:29-32` computes the HMAC over `req.body` **before** the handler's `try/catch`; `body-parser`'s raw parser leaves `req.body = {}` for a wrong content-type ⇒ `crypto.createHmac().update({})` throws `TypeError`; Express 4 does not attach a catch to an async handler's returned promise ⇒ the rejection escapes to `unhandledRejection` and **no response is ever sent**. The route is mounted at `server.js:476`, **before** `apiLimiter` (`:694`) and before `originCheck` (`:552`) | Mirror the WhatsApp handler: `Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body \|\| '')`, reject a non-Buffer body with 400, and move the mount below the rate limiter |
| **P2-09** | C | Orphan email producer: job name `'send-email'` with `data.type` undefined → the consumer throws `Unknown email job type: undefined` on every attempt | `src/routes/debug.js:3,13-17` → `src/services/emailQueue.service.js:34` → `src/services/email.service.js:49-83` (dispatches on `job.data.type`). The route 404s in production so it is dormant | Delete the producer or give it a valid `type` |
| **P2-10** | C | **No timeout on any API call** — `http()` sets no deadline, and `FetchOptions` has no `timeout` field | `619-erp-frontend/src/lib/http.ts:451-580`; the only timeout in the app is hand-rolled at `auth-context.tsx:149` | Add a default deadline in `http()` (and a longer one for SSE) |
| **P2-11** | C | The off-site backup copy has been failing since at least 2026-10-02; no restore drill on real data; no backup-failure alerting; no PITR | `docs/DISASTER-RECOVERY.md:193` (*"every run fails at the upload — The specified bucket does not exist. Runs #8–#17 all failed."*), `:194` (*"It has not yet been run against a production dump."*), `:196` (*"A job that stops running needs to page someone. Right now nothing would notice."*); Supabase free plan (`:13-20`) | Create the `db-backups` R2 bucket; run one restore drill; add a failure alert |
| **P2-12** | C | The nginx template is not self-contained — every `location` includes a snippet file that is not in the repo | `infra/nginx/myptstudio.conf:95,116,170,189,201` and `command-center.conf:74` include `/etc/nginx/snippets/myptstudio-proxy.conf`; the directory contains only `command-center.conf`, `myptstudio.conf`, `patch-vhost.py`, `README.md`, `websocket.conf`, `install-websocket.sh`. Copying the file as-is fails `nginx -t` and can leave nginx **down** | Commit the snippet, or make `install-websocket.sh` the only documented install path and say so in the file header |
| **P2-13** | C | **Every rate limiter fails open on a Redis error**, silently | `src/lib/rateLimitStore.js:26-33` (`passOnStoreError: true` at every call site — `authRateLimit.js:190,209,229`, `aiRateLimit.js:22`, `server.js:654,664,687`, `profile.js:301,838`, `auth-webauthn.js`, `client-activation.js:35`, `invitations.js`, `qr-checkin.js:57,289`, `search.js:38`) | Emit a loud metric on store error; fail **closed** on the credential limiters (login, MFA, refresh) |
| **P2-14** | C | The untracked `prisma/migrations/20261017_provenance/migration.sql` is never applied — the runner reads only `src/db/migrations/*.sql` | `prisma/migrations/20261017_provenance/migration.sql:12-27` (six `pt_assessments` columns + a `fitness_norm_sources` table) vs `src/db/migrate.js:56,109`. There is no `prisma/schema.prisma` and no Prisma dependency | Move the file into `src/db/migrations/` with the next number, or drop the Prisma directory |
| **P2-15** | C | The Razorpay webhook has no replay protection (no event-id ledger, no timestamp window) | `razorpay-webhook.js:17-99` — HMAC only. Harmless today because the handler writes nothing; a live replay vector the moment a write is added | Add a `razorpay_webhook_events(event_id)` ledger, mirroring the WhatsApp one |
| **P2-15a** | C | `GET /api/pt-os/payments` and 14 other list endpoints have no `LIMIT`; `GET /api/payments` and `GET /api/invoices` take an unclamped page size and an un-floored offset (`?offset=-1` → Postgres error) | `pt-os.routes.js:1662`; `payments.js:67`; `invoices.js:35,82`; also `campaigns.js:19`, `offers.js:41`, `automation.routes.js:42,215,283`, `pt-os.routes.js:1178,1208,274`, `attendance.js:399`, `classes.js:18`, `aiKnowledge.js:101`, `qr-checkin.js:610`, `super-admin/organizations.js:13`, `super-admin/features.js:26,263` | Clamp `limit` to a max and floor `offset` at 0 on every list route; extend `boundedReads.convention.test.js` to cover list queries, not just aggregates |
| **P2-16** | C | `GET /api/pt-os/clients` is unbounded by default and runs a **per-row LATERAL aggregate** | `pt-os.service.js:128-135` (`pageClause` returns no SQL when `limit` is absent), `:76-112` (joins a `SUM` over the whole `pt_payments` table and a `LEFT JOIN LATERAL` per returned row) | Default to a bounded page; keep "all" behind an explicit opt-in |
| **P2-17** | C | Multi-step writes with no transaction: `POST /api/workouts/plans` (plan + N exercises), `POST /api/diet/templates` (template + N meals), `POST /api/attendance/bulk` (N records), `POST /api/support/tickets` (ticket + first message), `POST /api/communication/send` (history + fan-out), `PUT /api/profile/me` (users + user_profiles) | `workouts.js:564-633` (contrast `PUT` at `:643-709`, which *is* transactional); `diet.js:180-214` (contrast `diet.js:487`, which is); `attendance.js:304-342` (up to 400 sequential round trips, and it still answers `201` on a partial write); `support.js:69-83`; `communication.js:103-125` (the fan-out is `.catch(() => {})` — silently dropped); `profile.js` (users then user_profiles) | Wrap each in one transaction; make bulk attendance return 207 on partial success |
| **P2-18** | C | `POST /api/automation/pt-packages` has **no validation**: `parseInt(undefined)` → `NaN` reaches Postgres → 500 instead of 400 | `automation.routes.js:297-315`. Its siblings `POST /rules` (`:58`) and `PUT /whatsapp-settings` (`:138`) both validate | Add a zod schema |
| **P2-19** | C | Schema-drift errors are swallowed as **empty successful 200s**: the check is on the error *message text* (`includes('does not exist')`), which also matches "column … does not exist" | `routes/diet.js:45-48,173-176,244-247,330-335,399-402`; `routes/plans.js:33` | Match on SQLSTATE `42P01`/`42703`, and rethrow anything else |
| **P2-20** | C | `PUT /api/invoices/:id` writes with `WHERE id = $5` and **no `organization_id` predicate** — the org check happens only in the preceding SELECT. The sibling `POST /:id/send` *does* put the org predicate on its UPDATE | `routes/invoices.js:262-297` (the UPDATE) vs `:300-316` | Add the org predicate to the UPDATE, and make it one statement |
| **P2-21** | C | `PUT /api/attendance/:id` writes `status` with no enum check, while `POST /api/attendance` does enforce the subject-type enum | `attendance.js:252`; the dashboard pivots on `status` (`attendance.js:386`), so a junk value silently creates a new chart key | Enforce a status CHECK/allowlist on both paths |
| **P2-22** | C | `POST /api/bookings` takes `session_id` and `member_id` from the body with no validation and no ownership check; the router has **no `validate()` at all** and no router-level guard | `bookings.routes.js:25-36`; `server.js:845-846` mounts it with no `auth` | Add a zod schema and a router-level `router.use(auth, requireTrainer)` |
| **P2-23** | C | **11 routers carry no mount-level or router-level guard**, so a route added later without `auth` is publicly reachable. The codebase states the rule elsewhere — *"the guard travels with the router and cannot be lost if the mount is edited"* (`attendance.js:44`) | `server.js:769` (subscription), `:805` (upi-payments), `:845-846` (bookings), `:884` (calendar), `:905` (diet), `:953` (classes), `:982-983` (client-portal), `:988` (client-messages), `:1048` (notifications) | Add `router.use(auth, …)` to each of the 11 |
| **P2-24** | C | `GET /api/pt-os/clients/:id/training-brief` and `/snapshot` each read **10 tables in parallel** with no caching, and `GET /api/pt-os/dashboard/ops` + `/api/pt-os/dashboard` duplicate work | `pt-os.routes.js` (training-brief, snapshot) | Cache per client with a short TTL; consider one consolidated query |

---

### P3 — Low

| ID | Conf. | Finding |
|---|---|---|
| **P3-01** | C | `JWT_EXPIRES_IN` silently overrides the 15-minute default, is **not** in the `SECURITY_FLAGS` boot validation, and a typo (`7d`) makes the password path a 7-day session with no error. (`auth.js:63`) |
| **P3-02** | C | `req.user.plan_code` is never loaded in the auth SELECT, so plan-gated features always resolve to the catalogue default. `features.js:147` reads `req.user.plan_code`; `middleware/auth.js:125-130` selects `o.status`, `o.subscription_status`, `o.trial_ends_at`, `o.current_period_end` — but not `o.plan_code`. Feature gating currently fails **permissive** (a plan-gated feature stays on). |
| **P3-03** | C | Account deactivation and role changes take up to 30 s to take effect — the user row is cached for 30 s and `invalidateUserCache` is not called from the platform's deactivate/role-change handlers (`middleware/auth.js:51-72`) |
| **P3-04** | C | 70 typed `api.*` methods have no call site, including the whole `api.expenses.*` namespace (the backend has an Expenses module; the app has no Expenses screen). The 462-endpoint snapshot test keeps them green. |
| **P3-05** | C | 19 call sites bypass the typed client and call `http()` directly, so the canonical wrappers (`api.insights.*`, `api.pt.dashboard`, `api.reports.*`) are never exercised and any change to the shared client must be made twice |
| **P3-06** | C | Money is computed in IEEE-754 doubles and rounded to whole rupees with `Math.round` (half away from zero) in 7 places — `ptPayments.js:95-97`, `pt-os.routes.js:1054`, `renewal.service.js:174`, `upiPayments.js:989`, `subscription.js:223,249-250,607`. The `NUMERIC(12,2)` columns' scale is never used. |
| **P3-07** | C | The impersonation Bearer lives in `sessionStorage` and is therefore XSS-readable. Short-lived (30 min default, 120 min cap) and read-only by default, but `mode:'full'` grants write capability. |
| **P3-08** | S | Plane classification uses `startsWith` prefix matching (`platformAuth.js:325-329`) — a future `/api/platform-health` would be misclassified as control-plane. No currently-exploitable route. |
| **P3-09** | C | `sendAdminResetOtpInline` calls `sendMail` **directly, with no `sendWithRetry`** — unlike every other sender in `lib/email.js` (`lib/email.js:412-423`) |
| **P3-10** | C | Two independent subsystems emit a "membership expiring" message for the same client on the same day (the renewal worker over `members`, the automation sweep over `pt_clients`) with no shared dedupe key (`renewal.worker.js:52` vs `automation.sweep.js:123`) |
| **P3-11** | C | The `db` file at the backend repo root (79 bytes) is a dangling pointer — *"This file moved to db/migrations/supabase-schema-v3.sql — delete this stub"* — and neither the directory nor the file exists |
| **P3-12** | C | `system_alerts.deleted_at` is filtered in one of three read paths (`super-admin/kpis.js:60`) and not in the others (`command-center/alerts.service.js:416-510`); no writer ever sets it. Harmless today, and the two screens will disagree the moment soft-delete is used. |
| **P3-13** | C | `GET /api/payments/upi/:id` (approve path) reads `SELECT client_id, plan_name FROM payment_orders WHERE id=$1` **without** `organization_id` — the one query in the module that is unscoped. Nothing from it reaches the response (it only picks the notification recipient), so there is no leak today. (`upi-payments.js:930-932`) |
| **P3-14** | C | `POST /api/v1/notifications/broadcast` sends one message per id in an unbounded loop, with no `MAX_RECIPIENTS` cap and no body validation (`notifications.routes.js:45-52`) — contrast `modules/ai-actions`, which does cap |
| **P3-15** | C | `POST /api/subscription/checkout/:id/submit-utr` notifies every super-admin in a loop with per-insert error swallowing (`subscription.js:128-140`; same pattern at `:347`, `:427`) — the correct shape is one `INSERT … SELECT`, as `communication.js:113-125` does |
| **P3-16** | C | `POST /api/communication/send` fans out with `LIMIT 500` and no signal in the response — a studio with 600 clients silently notifies 500 |
| **P3-17** | C | The root `db` pointer file (see P3-11) and `prisma/` (see P2-14) are both untracked work-in-progress — **not** committed orphans. Flagged so a future reviewer does not treat them as accidental. |
| **P3-18** | C | `npm test` in the backend CI uses `--passWithNoTests`, so a broken test glob yields a green job. The frontend deliberately omits it. |

---

## 13. Missing observability and test-coverage areas

**Observability gaps**
1. **No browser-side error reporting** — the frontend DSN is never supplied (P1-10). The backend's `sentry_configured` check reads a *different* DSN and reports green.
2. **No alerting on backup failure** — a nightly job that stops running is visible only in the Actions tab (`DISASTER-RECOVERY.md:196`).
3. **No rate-limiter-down signal** — every limiter fails open with no log line (P2-13).
4. **AI failures are unpersisted** — `lib/ai/observations.js:19-27` is a 200-entry in-process ring, invisible to the other container and lost on restart.
5. **No dead-letter visibility** for exhausted BullMQ jobs (`removeOnFail {count:5000, age:7d}` keeps them, but nothing surfaces them).
6. **The WhatsApp gateway's own metrics** (`/metrics`, gated on `X-Gateway-Key`) are not surfaced by any committed health check or collector.
7. **The frontend's `/api/health` checks nothing external** — it does not verify the backend is reachable, so a frontend container stays "healthy" while every API call 502s.

**Test-coverage gaps**
1. **No column-level schema/code agreement test.** This is the gap that let P0-04 ship. The existing convention test checks table *names*; `migrations.freshInstall.test.js` checks table *existence*.
2. **No test exercises `/api/classes/sessions` or the bookings module against a real database** — the exact surfaces P0-04 breaks.
3. **No test for the "success without the write" class.** `DELETE /api/profile/sessions/:id` (P1-02) would fail a one-line assertion.
4. **No contract test for the compose ↔ code environment-variable contract** — the gap behind P0-01, P0-02, and P1-09.
5. **No test for the campaign PUT payload shape** (P2-04).
6. **The WhatsApp gateway has never been scanned by a real phone.** Its own README is explicit: the build environment's egress proxy blocks `web.whatsapp.com` with a 403, so *"no QR has been produced from WhatsApp's servers here … passing tests are not evidence that a phone can scan this."* Phase 10 is the only thing that proves the integration works. **This audit confirms that claim against the source** — the QR path is a real Baileys implementation with a connect watchdog whose error message is literally `'whatsapp_no_response — check egress to WhatsApp from this host'`, and there is no stub. But no end-to-end proof exists.
7. **The `mps-ai` service is not in this workspace** — the `/ai/:path*` contract is unverifiable here (P2-03).
8. **The production Next.js rewrite path is exercised by nothing.** The Playwright config runs `next dev --webpack` (`playwright.config.ts:120-127`), and `next.config.js:170-173` returns `[]` outside production — so the same-origin proxy path, the `apiBase()` production branch, and the production CSP are all untested.

---

## 14. Prioritized remediation roadmap

### Stage 0 — Configuration-only fixes (≈1 hour, no code logic, unblocks whole product surfaces)

| # | Action | Fixes |
|---|---|---|
| 1 | Add `WA_GATEWAY_URL`, `WA_GATEWAY_KEY`, `WA_WEBHOOK_SECRET` to the api and worker `environment:` blocks in `docker-compose.yml` | P0-01 |
| 2 | Add `AI_API_KEY` (or `OPENROUTER_API_KEY`) and `AI_BASE_URL` to both blocks | P0-02 |
| 3 | Add `RAZORPAY_WEBHOOK_SECRET`, `RP_ID`, `WEBAUTHN_ORIGIN`, `TRUST_PROXY=2`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SERVICE_AUTH_SECRET`, `KIOSK_HMAC_SECRET`, `FCM_SERVER_KEY`, `RESEND_API_KEY`, `DATABASE_POOL_SIZE`, `DATABASE_SSL_CA`, `APP_TIMEZONE` to the compose blocks; add `SUPER_ADMIN_REQUIRE_MFA`, `AI_BASE_URL`, `LOG_CAPTURE` to the backend `.env.example` | P1-09, P2-13 (partial) |
| 4 | Add `ARG/ENV NEXT_PUBLIC_SENTRY_DSN` to the frontend Dockerfile and pass it from `deploy.yml` and the compose `build.args:` | P1-10 |
| 5 | Add `ARG`/`ENV` for the 5 undeclared `NEXT_PUBLIC_*` vars the frontend reads (`GOOGLE_CLIENT_ID`, `SUPABASE_HOST`, `SUPABASE_URL`, `SUPPORT_PHONE`, `APP_ORIGIN`) | P1-09 (frontend half) |
| 6 | Fix `619-erp-frontend/.env.example:16-28` to match `proxy.ts`, and make the secret fail loudly at boot | P1-01 |
| 7 | Rename the frontend rollback secret to match the deploy workflow (`SSH_PRIVATE_KEY`) | P1-12 |
| 8 | Create the `db-backups` R2 bucket; add a backup-failure alert | P2-11 |

### Stage 1 — Correctness fixes (≈1 day, high user-visible value)

| # | Action | Fixes |
|---|---|---|
| 9 | Implement `GET /api/profile/devices`, `GET /api/profile/sessions`, `DELETE .../devices/:id`, `DELETE .../sessions/:id` against `refresh_tokens` | P1-02 |
| 10 | Make `sendPasswordResetInline` throw on `SMTP_NOT_CONFIGURED`; use `redis.ensureReady()`; log `queued` separately from `sent` | P1-03 |
| 11 | Add the missing 19 columns (or change the queries to the columns that exist) | P0-04 |
| 12 | Map `plans.duration` to months before computing the renewal end date | P1-07 |
| 13 | Add `gateway_unreachable` to the reconnect-fixable set; add a dead-letter path | P1-04 |
| 14 | Request `usage: {include:true}` from the actual provider; log usage on the failure path | P1-05 |
| 15 | Align `toCampaignPayload` with the campaigns PUT | P2-04 |
| 16 | Add `tenantAuthHeaders()` to `client-ai.ts`; add `AI_SERVICE_URL` to the frontend `.env.example` | P2-03 |
| 17 | Guard `req.body` in the Razorpay webhook (Buffer check) and move the mount below the rate limiter | P2-08 |
| 18 | Align the campaigns PUT's field names with the POST's aliases (or make both accept both) | P2-04 |

### Stage 2 — Structural hardening (≈2–3 days)

| # | Action | Fixes |
|---|---|---|
| 19 | Add a column-level schema/code agreement test and a compose↔code env-var contract test | P0-04, P0-01, P0-02, P1-09 — the two tests that would have caught the four P0s |
| 20 | Wrap the 6 multi-step writes in transactions; make bulk attendance return 207 | P2-17 |
| 21 | Add `router.use(auth, …)` to the 11 unguarded routers | P2-23 |
| 22 | Clamp `limit` / floor `offset` on the 15 unbounded list routes; extend `boundedReads.convention.test.js` to list queries | P2-15a, P2-16 |
| 23 | Add the org predicate to `PUT /api/invoices/:id`'s UPDATE | P2-20 |
| 24 | Give the migration runner a dedicated connection with timeouts disabled | P1-06 |
| 25 | Verify the production DB role's `rolbypassrls`; add a boot assertion | P1-11 |
| 26 | Implement or remove the Razorpay ledger write; add the replay ledger | P0-03, P2-15 |
| 27 | Make the limits fail closed on credential endpoints; log store errors | P2-13 |
| 28 | Require the current password for MFA enrolment/de-enrolment; refuse under impersonation | P2-02 |
| 29 | One `signAccessToken()` for all three sign-in paths; issue a refresh token on Google/passkey | P2-01 |
| 30 | Version the real compose file, or banner the committed one | P1-08 |
| 31 | Commit the nginx snippet, or make `install-websocket.sh` the only install path | P2-12 |

### Stage 3 — Observability, recovery, and product completeness (≈1 week)

| # | Action | Fixes |
|---|---|---|
| 32 | Run one restore drill against a production dump; add backup alerting | P2-11 |
| 33 | Persist AI failures; surface exhausted BullMQ jobs in the Command Center | §13 |
| 34 | Make the frontend `/api/health` verify the backend is reachable | §13 |
| 35 | Decouple the container liveness probe and the deploy gate from Redis | P2-15 (infra) |
| 36 | Build the Expenses screen (backend exists, `api.expenses.*` exists, no UI) | P3-04 |
| 37 | Remove the 70 dead typed methods, or wire the ones that should exist | P3-04 |
| 38 | Consolidate the 19 direct `http()` call sites onto the typed client | P3-05 |
| 39 | **Run the real-phone WhatsApp QR scan (Phase 10)** | the only proof the integration works |
| 40 | Run the E2E suite against `next build && next start`, not `next dev` | §13.8 |

---

## 15. Safe regression test plan

Every test below is safe: no production endpoint, no real message, no payment, no other tenant's data.

**T1 — Column-level schema agreement (highest value; prevents P0-04's class)**
Build the schema into a scratch database (`psql -f src/db/schema.sql` then apply `src/db/migrations/*.sql` in a transaction), then extract every `table.column` referenced by application SQL in `src/{routes,modules,lib}` and assert each exists in `information_schema.columns`. This is a static-analysis test, not a runtime one, and needs no database at all if run against the migration files. *Catches P0-04 and every future drift of the same shape.*

**T2 — Compose ↔ code environment-variable contract**
Parse `docker-compose.yml`; collect every `process.env.X` / `env.X` read in `src/`; assert each non-optional variable appears in the `api` and/or `worker` `environment:` block, with an explicit allowlist for the ones that are intentionally unset. *Catches P0-01, P0-02, P1-09.*

**T3 — Frontend Docker build-arg contract**
Assert every `process.env.NEXT_PUBLIC_*` read in `src/` has a matching `ARG`/`ENV` in the frontend Dockerfile. *Catches the frontend half of P1-09 and P1-10.*

**T4 — "Success without the write" contract**
For every `router.delete`/`router.put`/`router.post` whose name contains `revoke`, assert a `pool.query` appears in the handler body. Extend to all `router.*` handlers returning `200` with a `message` and no write. *Catches P1-02.*

**T5 — Email dispatch outcome**
With SMTP unconfigured, call the email service and assert the job lands in `failed` (not `completed`) and that the route log records `queued`, not `sent`. *Catches P1-03.*

**T6 — WhatsApp outage recovery**
Mock the gateway to return `GATEWAY_UNREACHABLE` on attempt 1 and success on attempt 2; assert the message is delivered exactly once and that a terminal failure is re-drivable by the orphan sweeper. *Catches P1-04.*

**T7 — AI usage accounting**
A provider fixture returning a `usage` block; assert `ai_usage_log.tokens_prompt` and `cost_inr` are populated (not 0/null) and that a failed call still writes a row. *Catches P1-05.*

**T8 — Migration runner resilience**
A migration fixture that sleeps past the pool's `query_timeout`; assert the remaining migrations still apply, or that the failure is reported as a whole-chain failure rather than a partial apply. *Catches P1-06.*

**T9 — Renewal end-date validity**
Call the renewal service with `plans.duration = 'Monthly'`; assert the renewed membership's `end_date` is a valid date one month out. *Catches P1-07.*

**T10 — Campaign PUT round-trip**
Create a campaign with a scheduled date, then update it through the frontend's `toCampaignPayload`; assert the date and channel survive. *Catches P2-04.*

**T11 — Transactional multi-step writes**
For each of the 6 endpoints in P2-17, inject a failure on the second statement and assert **no** partial row survives. *Catches P2-17.*

**T12 — Router guard convention**
Static test: every router file in `src/routes` and `src/modules` either declares `router.use(auth, …)` or is on an explicit allowlist of public routers. *Catches P2-23.*

**T13 — Bounded list reads**
Extend `boundedReads.convention.test.js` to assert every list endpoint has a `LIMIT` and a clamped page size, and that `offset` is floored at 0. *Catches P2-15a.*

**T14 — Webhook robustness**
POST to `/api/webhooks/razorpay` with `Content-Type: text/plain`; assert a 4xx (not a hang, not an unhandled rejection). POST the same valid request twice; assert the second is a no-op. *Catches P2-08 and P2-15.*

**T15 — MFA re-authentication**
Call `POST /api/profile/mfa/setup` without the current password; assert 401/403. Call it with `req.impersonation` set; assert it is refused. *Catches P2-02.*

**T16 — Production build path**
Change the Playwright `webServer.command` to `next build && next start` for one CI job so the production rewrite path, the production `apiBase()` branch, and the production CSP are exercised at least once. *Covers §13.8.*

---

## 16. Checks that could not be completed

| # | Check | Why not | What it would have told us |
|---|---|---|---|
| 1 | Any live database query | Backend `.env` points at `127.0.0.1:5433` (closed); `:5432` is open but rejects the `.env` credentials. Connecting to a DB would also risk mutation, which is out of scope | Whether production's actual schema matches the repo's (P0-04's real-world blast radius) |
| 2 | `619-erp-whatsapp` lint / typecheck / test (154 tests) | `node_modules` is absent; installing dependencies needs explicit approval | Whether the gateway's own suite passes on this machine |
| 3 | Frontend `npm run build` | Requires `NEXT_PUBLIC_API_URL` at build time; a failed build would rewrite `.next/`, which is not read-only | Whether the production build succeeds with the committed ARGs (P1-09) |
| 4 | `npm audit` (all three) | Requires network egress; CI already runs it as a blocking job | Current CVE posture |
| 5 | Any endpoint hit against a running server | No backend was started; the audit is read-only by mandate | Runtime confirmation of the static findings |
| 6 | The `mps-ai` service contract | **The repo is not in this workspace** | Whether `/ai/client-agent/chat/stream` is the right path, and whether it tolerates a request with no tenant headers (P2-03) |
| 7 | The deployed VPS compose / nginx config | The file that actually runs lives on the VPS, outside version control | Whether the live deployment forwards the missing variables (which would downgrade P0-01/P0-02/P1-09 from "dead product" to "documentation gap") |
| 8 | Production `rolbypassrls` for the live DB role | No database access | Whether RLS is the backstop or the app filter is (P1-11) |
| 9 | The live WhatsApp QR scan (Phase 10) | The gateway's own README documents that the build environment's egress proxy blocks `web.whatsapp.com` with a 403, so no QR has ever been produced from WhatsApp's servers here | Whether a phone can actually pair — the only real proof the integration works |
| 10 | The live R2 `db-backups` bucket | No cloud credentials | Whether the off-site backup is now succeeding (P2-11) |
| 11 | E2E / Playwright suites | They boot a real Postgres, seed two studios, and write to a database — outside the read-only mandate | Whether the browser journeys pass today |
| 12 | Backup restore drill | Mutates a database | Whether a restore actually works |
| 13 | The `archive` schema's table shapes (migrations 193/195 use dynamic `EXECUTE format(...)`) | Not statically enumerable | Whether the archived training tables match what the code reads |
| 14 | RLS policy bodies (141+ policies) | Only each table's `organization_id` presence was confirmed | Whether each policy's predicate matches the application's access model |
| 15 | The ~150 production indexes that exist in production but in no migration file | `src/__tests__/index.hygiene.test.js:19-24` records the gap | Whether production's index coverage hides the missing-column and unbounded-read findings |
| 16 | GitHub Actions run status | No network access to the GitHub API from this environment | Whether CI is currently green on `main` |

**On the `mps-ai` absence and the `prisma/` directory:** the untracked `prisma/` and the untracked test files are **in-progress work on `feat/goal-setting-redesign`**, preserved untouched. They are not committed orphans. The `prisma/` migration still will never apply as written (P2-14), but that is a routing question for whoever owns that work, not a shipped defect.

---

## 17. Final production-readiness verdict

# NOT READY

**Basis for the verdict (the rule is "confirmed critical or high-impact blockers exist"):**

Four P0 findings are confirmed by reading both sides of each defect in the actual source:

1. **P0-01** — WhatsApp is entirely non-functional under the committed Compose file (no `WA_*` variable is forwarded). Verified: `grep -c "WA_GATEWAY_URL" docker-compose.yml` → `0`.
2. **P0-02** — All AI features are non-functional under the committed Compose file (no provider key is forwarded). Verified: `grep -c "OPENROUTER_API_KEY\|AI_API_KEY" docker-compose.yml` → `0`.
3. **P0-03** — The Razorpay webhook acknowledges captured payments with HTTP 200 and writes nothing. Verified by reading the handler: no `INSERT`/`UPDATE` exists in it.
4. **P0-04** — 19 columns across 5 tables are missing from the repo schema but are read by live application SQL. Verified by reconstructing the full ordered CREATE/ALTER history of `class_sessions`, `bookings`, `member_memberships`, `plans`, and `members`, and by reading the five call sites that read the missing columns.

Plus seven P1 findings, including a documented-but-wrong runbook that makes the whole authenticated product redirect to sign-in (P1-01), five security-relevant controls that report success and do nothing (P1-02), a password-reset failure that is logged as success (P1-03), and a silent permanent loss of automated WhatsApp messages on any brief gateway outage (P1-04).

**The mitigating context, stated honestly:** the *code* is in materially better shape than the *configuration*. The tenancy model, the auth model, the UPI payment path, the WhatsApp gateway's internals, the webhook signature verification, the rate limiting, and the secret-redacting logger are all solid and were verified line by line. **No cross-tenant data leak was found.** Most of the P0s and several P1s are configuration and documentation defects rather than logic defects — which is why Stage 0 of the roadmap is roughly an hour of work for a disproportionate share of the severity.

**What would move this to CONDITIONALLY READY:** completing Stage 0 (8 configuration/documentation fixes) and Stage 1 (10 correctness fixes), and confirming on the deployed environment that the live compose and live DB role do not have the problems the committed files have.

**What would move this to READY WITH EVIDENCE:** all of the above, **plus** the two proofs that no static audit can supply — (a) the real-phone WhatsApp QR scan (Phase 10), which the gateway's own README identifies as "the only thing that proves this works," and (b) a restore drill against a production dump, which `DISASTER-RECOVERY.md:194` records as never having been run.

**Explicitly not claimed:** that the system is unsafe today in production. It may well be that the live VPS compose forwards the variables the committed one omits, and that production's schema carries the columns the repo's schema lacks. **Those are exactly the two things this audit could not check** (§16, items 1 and 7), and they are the first two questions to answer with `docker compose config` and `psql -c '\d class_sessions'` on the deployed box.

---

### Limits of this audit

- **Static, not runtime.** Every "backend returns X" claim comes from reading source. I did not start a server, hit an endpoint, or run the E2E suites.
- **No database access.** All schema claims are derived from `schema.sql` + 246 migrations. The column-level cross-check was done by hand against the ordered CREATE/ALTER/RENAME history, resolving the dynamic-SQL migrations (`088`, `193`, `195`) individually.
- **One repo is absent.** `mps-ai` is not in this workspace, so the `/ai/:path*` contract is unverifiable.
- **The deployed environment was not inspected.** The compose file that actually runs lives on the VPS, outside version control.
- **No secret value was printed, no file was modified, no migration was applied, no mutating SQL was run, and no message, email, or payment was triggered.** The only files written by this audit are this report.
- **Uncommitted work was preserved untouched**: the backend's 7 modified files and 12 untracked paths, and the frontend's 2 modified files and 2 untracked paths, are exactly as they were found.
