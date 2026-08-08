# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

619 Fitness ERP backend — a multi-tenant SaaS API for personal-training studios ("619 Fitness ERP" / "MY PT STUDIO"). Express 4 + raw `pg` against Supabase-hosted PostgreSQL (no ORM, no Prisma). CommonJS throughout (`require`/`module.exports`), Node >= 20.19.

Tenants are `organizations`. Every request is scoped to the caller's `organization_id` at the application layer (see Multi-tenancy below) — there is no ORM-level or RLS-level backstop, so getting this right in each route is load-bearing.

## Commands

```bash
npm run dev              # nodemon src/server.js — local dev server
npm start                # node src/server.js — production entry point

npm test                 # jest --forceExit --detectOpenHandles (all tests)
npm test -- path/to/file.test.js         # single test file
npm test -- -t "test name substring"     # single test by name
npm run test:watch       # jest --watch

npm run lint             # eslint . — CI runs this with --max-warnings=0

npm run migrate          # apply pending SQL migrations (also runs automatically on server boot)

npm run worker:all       # run all BullMQ workers in a separate process
npm run worker:email     # run a single worker (email/whatsapp/ai/notifications/renewal also available)

npm run e2e:setup        # bash scripts/e2e-setup.sh — provision DB for E2E runs
npm run seed:e2e         # seed data for E2E

npm run verify:smtp      # scripts/verify-smtp.js — test SMTP credentials end-to-end
npm run verify:embeddings
npm run verify:indexes
```

Jest tests live in `src/__tests__/*.test.js` and run against a real Postgres (CI spins up a `postgres:15` service; `DATABASE_URL` must point at a real database — there is no mocked DB layer).

## Architecture

### Entry point and middleware order

`src/server.js` is a single large file that wires up the whole app, and **order matters** — comments throughout explain why. Key sequencing:

1. Env validation fails fast (`DATABASE_URL`, `JWT_SECRET`, `FRONTEND_URL` required; SMTP and R2 object storage are validated as all-or-nothing, R2 is fatal in production if unset because uploads would silently fall back to ephemeral disk).
2. `helmet` (strict CSP — this is a JSON API, no scripts/styles served) → CORS (origin allowlist from `CORS_ORIGIN` + `FRONTEND_URL`) → the Razorpay webhook route (mounted before body parsing so it can read the raw body for signature verification) → JSON body parsing (100kb default, a 4mb carve-out for three specific base64-image endpoints) → origin/referer check → input sanitization → request ID → structured request logger.
3. Rate limiters: a global IP limiter, a per-user limiter (keyed on `req.user.id`, so it must be applied after `auth`), and tighter limiters on login/register endpoints.
4. `branchScope` runs after auth, before route handlers, and is a no-op for single-branch installs.
5. Routes are mounted (see below), then `notFound` → Sentry error hook → `errorHandler`.
6. Migrations run automatically on boot (`runMigrationsWithRetry`) before the server starts listening. Background workers, the Command Center websocket stream, subscription/UPI/announcement sweeps, and alert evaluation all start after that, each independently toggleable via env vars documented inline (`RUN_WORKERS`, `COMMAND_CENTER_STREAM`, `SUBSCRIPTION_SWEEP`, `ANNOUNCEMENT_DISPATCH`, `UPI_EXPIRY_SWEEP`, `LOG_CAPTURE`, `ALERT_EVALUATION`, `AI_EMBEDDING_WARMUP`).

Read the comments in `src/server.js` before changing route mount order or middleware placement — several past incidents (cross-tenant data exposure, an unguarded destructive admin route) are documented at the mount points that caused them.

### Two routing patterns coexist

- **Legacy flat routers**: `src/routes/*.js`, one file per resource, mounted directly in `server.js` (e.g. `routes/clients.js`, `routes/payments.js`).
- **Newer module pattern**: `src/modules/<name>/` containing `<name>.routes.js` (Express router) plus `<name>.service.js` (business logic/queries), sometimes with additional files for sub-concerns (e.g. `modules/pt-os/` splits into `pt-os.routes.js`, `parq.routes.js`, `informed-consent.routes.js`, `workout-log.routes.js`, each with matching service/helper files).

New tenant-facing features should generally follow the module pattern. Some routes are intentionally double-mounted under both `/api/x` and `/api/v1/x` for legacy mobile client compatibility (auth, bookings) — changes to those routers must be tested against both prefixes.

Several routers are mounted with a `gate(featureKey)` helper (`[auth, requireFeature(key)]`) for premium/toggleable features (`packages`, `finance`, `insights`, `programs`, `integrations`, `communication`, `ai_suite`, `ai_knowledge_base`). Core flows (auth, subscription/payments, clients, sessions) are deliberately never feature-gated.

### Multi-tenancy (read before touching any tenant-table query)

The database itself provides **no tenant isolation backstop**: the app connects as `postgres`, which bypasses RLS, and existing RLS policies are deny-all for anon/authenticated PostgREST roles only — not a defense against this API. Tenant isolation is enforced entirely in the application layer via `src/lib/tenant-db.js`:

- `tenantScope(req)` — resolves `{ isSuperAdmin, orgId, applyFilter }`. Tenant users are always scoped to `req.user.organization_id`; a `super_admin` sees everything unless an `x-org-id` header targets one org; an org-less tenant user matches zero rows rather than leaking cross-tenant.
- `orgIdOf(req)` — the org id to stamp onto newly created rows.

Every route touching a tenant table must reference these helpers (or an equivalent org filter). `src/__tests__/tenantScope.convention.test.js` statically greps the route source for this — it's a coarse, file-level guard against a whole new route shipping with no tenancy awareness, not a per-query verifier. See `src/db/migrations/TENANT-RLS-PLAN.md` for the plan to eventually enforce this at the database level, and `BACKEND-FRONTEND-AUDIT.md` for the history of routes that got this wrong.

### Database & migrations

Plain SQL files in `src/db/migrations/*.sql`, sequentially numbered (`NNN_description.sql`). Applied automatically on every boot (`src/db/migrate.js`), guarded by a Postgres advisory lock (`LOCK_ID = 619619619`) with stale-holder detection so a `SIGKILL`ed boot can't deadlock future deploys. Already-applied files are skipped, so `npm run migrate` is safe to run repeatedly. Add new migrations as the next sequential number; don't edit applied ones.

### Auth & authorization

- `middleware/auth.js` — JWT verification, populates `req.user`.
- `middleware/rbac.js` — `requireStaff` / `requireClient` role gates.
- `middleware/tenant.js` — `requireSuperAdmin`, `requireSuperAdminMfa` for platform-level (cross-tenant) routes; these are distinct from tenant-admin (`adminOnly`) and must guard anything platform-destructive.
- Client-portal routes (`/api/me`) scope strictly to `req.user.pt_client_id`, never to an id taken from the request.

### Background jobs

BullMQ queues in `src/jobs/`, workers in `src/workers/`. On the single-instance VPS deploy, workers normally run in-process inside the API server (`RUN_WORKERS` unset/`1`); the `docker-compose.yml` topology instead runs a dedicated `worker` service with `RUN_WORKERS=0` on the API container to avoid double-draining. Without Redis configured, queued work degrades to inline synchronous sends automatically — dev machines need no Redis setup.

### Testing conventions

Most tests are ordinary Jest request/integration tests under `src/__tests__/`, but a meaningful subset are **convention tests** — static source-analysis checks (grep-style, not runtime) enforcing architectural invariants that a live-DB test can't catch pre-merge: tenant scoping (`tenantScope.convention.test.js`), RLS usage, and legacy-table access (`clients.legacy-table.test.js` fails if anything reads the abandoned, unscoped `clients` table). When adding a route that queries a tenant table, expect these to run against it.

### Deployment

Self-hosted VPS (not Render/Vercel, despite some inline comments referencing Render from an earlier topology) via Docker Compose (`docker-compose.yml`: `redis`, `api`, `worker` services) behind nginx (`infra/nginx/`). CI (`.github/workflows/ci.yml`) runs lint (zero-warning tolerance), Jest against a real `postgres:15` service container, and `npm audit --audit-level=high`. `deploy.yml` triggers only on a **successful** CI run on `main` (`workflow_run`, not a duplicate `push` trigger) plus a manual `workflow_dispatch` break-glass path; it pulls, rebuilds, migrates, then brings the stack up on the box. `rollback.yml` exists for reverting a bad deploy.

### Notable root docs

- `SUBSCRIPTION.md` — subscription/trial/billing lifecycle (`trial → active → frozen/expired`), plan catalogue, admin-activated billing model.
- `SEARCH.md` — the global search endpoint's response envelope (`/api/search`), a type-agnostic `{ title, subtitle, meta, badges, href }` shape shared across entity types.
- `BACKEND-FRONTEND-AUDIT.md` / `COMMAND-CENTER-PLAN.md` — historical audit and design notes; useful context for why certain routes/tables were removed or restructured, not living specs.

## Code style

- ESLint (`eslint.config.js`): `eqeqeq` required except against `null` (the `x == null` idiom is intentional and matches both `null`/`undefined`); `no-unused-vars` ignores `_`-prefixed args/catch bindings and rest-sibling destructuring (`const { foo: _f, ...rest } = x` is the standard way this codebase strips fields); `no-console` is warn-level everywhere except `scripts/**`, `src/db/migrate.js`, `src/db/seed.js`, where stdout is the interface.
- No TypeScript — plain JS with CommonJS modules.
