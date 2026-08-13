# RLS cutover — readiness audit

Companion to `TENANT-RLS-PLAN.md`, which is the design and remains the source of
truth. This document does not propose a different architecture. It answers one
question the plan does not: **is the cutover safe to perform right now?**

**Verdict: NOT READY.**

Audited against `main` @ `3c841d2`. The first pass was static. A second pass
(Phase 1.5) built a real PostgreSQL 16 from `schema.sql` + all 160 migrations via
`scripts/rls-proof-setup.sh`, connected as the real `app_tenant` role, and
settled by query the things reading files could not. Two findings came out of
that, and both are worse than the static pass suggested:

- **77 tables**, not eleven, have RLS enabled with no `app_tenant` policy. 61 of
  them are referenced by live code.
- **`pool.connect()` was broken outright** under `TENANT_RLS_ENFORCE=on` — a
  double-release on every reused connection. Found by the concurrency test, fixed
  in the same pass. Had the flag been switched on without this, every
  transactional write path would have started throwing.

Sections marked **[verified]** were run against that database. Anything not so
marked is still read from source.

---

## What "the cutover" actually is

Two independent switches, deliberately separable:

| Switch | What it does | Reversal |
|---|---|---|
| `TENANT_RLS_ENFORCE=on` | `db/pool.js` wraps queries in a transaction that sets `app.org_id` | env var + restart |
| `DATABASE_URL` → `app_tenant` | the app stops connecting as a `BYPASSRLS` role, so policies apply | env var + restart |

Neither does anything alone. The flag without the role sets a GUC nothing reads;
the role without the flag connects as a role that matches no policy and reads
nothing. **They must never be changed in the same deploy** — that property is
what makes every stage below individually reversible, and it is the single most
valuable feature of the current design.

---

## Evidence table

| Area | Status | Evidence | Risk |
|---|---|---|---|
| **Role** | READY | `157:34` — `CREATE ROLE app_tenant WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`. No password set in the migration, deliberately; it is set out of band. | Low |
| **Policies — org tables** | READY | `157:78-113` discovers its list from `information_schema` (every base table with an `organization_id`), so a tenant table added later is covered without anyone remembering. `FOR ALL` ⇒ SELECT/INSERT/UPDATE/DELETE. Two shapes: strict, and shared for the 8 tables with legitimate NULL rows. Granted **only** to `app_tenant` — never `public`/`anon`/`authenticated`, which is the mistake 131 had to clean up. | Low |
| **Policies — gap tables** | **NOT READY** | See "The inventory problem" below. | **High** |
| **Shared / platform data** | READY | `159` gives `subscription_plans`, `subscription_coupons`, `platform_payment_settings` a `USING (true)` policy — they are the catalogue studios buy *from*, and scoping them would empty the pricing page for every studio at once. Write authority stays where it already is (`requireSuperAdmin` at the route), so this preserves the current boundary rather than inventing a new one. | Low |
| **Child tables** | READY | `159` writes the parent's org predicate out explicitly rather than relying on the parent's policy applying through the subquery. Every FK used is already indexed. `workout_sets` is handled separately as a two-hop grandchild. | Low |
| **Tenant context** | READY | `lib/tenant-context.js` — AsyncLocalStorage. Three states, not two: no store (worker/cron/pre-auth) → owner connection; store with `platformWide` (operator) → owner connection; store with an org, **or with none** → `app_tenant`. The distinction between "no store" and "store with null org" is what lets a worker read platform-wide while an org-less authenticated request reads nothing. `platformWide` is a separate flag rather than inferred from `orgId == null`, precisely so those two cannot collapse into the dangerous one. | Low |
| **Pooling** | READY | `pool.js:230-243` uses `set_config('app.org_id', $2, true)` — the third argument is `is_local`, so the setting dies with the transaction and cannot survive on a reused pooled connection. Correct for Supavisor transaction mode, which rejects session-level `SET` and startup parameters. `scopeClient` restores pristine methods on `release()` and guards against wrapper-stacking with a `PRISTINE` symbol (`pool.js:327-385`). | Low — but see caveat |
| **Cross-request leakage** | READY *by construction* | AsyncLocalStorage is per-async-context; two concurrent requests cannot see each other's store. **Not yet demonstrated under concurrency** — see condition C3. | Low |
| **Transactions** | CONDITIONS | Both wrappers exist (`pool.query` and `pool.connect`). `pool.js:366-375` logs `tenant_scope_gap` when a borrowed client runs a query **outside** a transaction, where `app.org_id` will not be set. The detection mechanism is built; **the list it produces has never been generated**, because it only emits with the flag on against a real database. | Medium |
| **Platform access** | READY | **`159`'s stated open question is already answered in code.** That migration's footer, and `STAGING-PLAN.md`, both say platform-wide super-admin traffic would read zero rows and needs "either a BYPASSRLS connection of its own, or an explicit sentinel". `pool.js:176-214` implements the first: `ADMIN_DATABASE_URL` + a lazily-built `ownerPool()`, selected by `useOwnerConnection() = TENANT_RLS_ENFORCE && SEPARATE_ADMIN_CONNECTION && isPlatformWide()`. It is explicit, auditable, and confined to one pool — **not** a fake owner tenant, **not** a sentinel org id, **not** RLS disabled. Both documents predate it and should be read with that in mind. | Low |
| **Workers / cron / scripts** | READY | No ALS store ⇒ `isPlatformWide()` true ⇒ owner connection (`tenant-context.js:86-89`). Correct and deliberate: the renewal sweep and subscription sweep are genuinely platform-wide. | Low |
| **Pre-auth routes** | READY | Same path. Login cannot scope itself to a studio before it has found the user whose studio it is. | Low |
| **Tests** | CONDITIONS | Strong and specific: `rls.isolation.integration.test.js` connects as the real `app_tenant` role and asserts all four verbs are blocked cross-tenant; `rls.convention.test.js`; `tenantScope.convention.test.js` (mutation-tested); `appTenantRls.migration.test.js`; `tenantRlsFlag.test.js`; and `e2e/tenant-isolation.api.spec.ts` in the frontend repo, which already drives cross-tenant attempts over HTTP including `x-org-id` widening. **None has ever run against an API process connected as `app_tenant`.** The integration suite self-skips without `RLS_TEST_DATABASE_URL`. | Medium |
| **Staging** | **NOT READY** | `STAGING-PLAN.md`: *"there is no staging."* `ci.yml` triggers on a `staging` branch that has never existed. Rollout steps 2–4 all require one. | **High** |

---

## The inventory problem — **[verified]**, and it is 77 tables

The static pass could not settle this. The query below was run against a real
database built from all 160 migrations, connected as the real role. **It returns
77 tables.** Migration 159's header — "Eleven tables in `public` have RLS ENABLED
… and no policy naming app_tenant at all" — is wrong by a factor of seven, and
that header is the reason the gap was believed closed.

61 of the 77 are referenced by live source outside tests. The full list is
reproducible with the query at the end of this section; the ones whose breakage
would be most visible, with the connection each is reached on:

| Table | Reached from | Connection at cutover | Effect |
|---|---|---|---|
| `notifications` | 11 files — `subscription`, `upi-payments`, `communication`, `client-activation`, plus platform/worker | **tenant** for the studio-facing ones | bell and in-app notices go empty |
| `ai_usage_log` | `lib/aiQuota.js` on every AI request | **tenant** | quota reads 0 used ⇒ **enforcement fails open** |
| `ai_conversations`, `ai_messages` | AI Coach history | **tenant** | conversation history vanishes |
| `user_profiles` | `routes/profile.js` (tenant) and `requireSuperAdminMfa` (platform) | **both** | tenant profile empty; platform path safe on the owner pool |
| `refresh_tokens` | `/api/auth/refresh` (no `auth` middleware ⇒ no ALS store ⇒ owner pool) and `routes/profile.js` session list | **mixed** | refresh itself is **safe**; the session list empties |
| `feature_flags`, `system_settings` | `routes/settings.js` | **tenant** | settings screens empty |
| `invoice_items`, `session_balance`, `pt_commissions`, `pt_packages`, `pt_payouts`, `pt_client_renewals`, `pt_client_subscriptions` | finance + PT OS | **tenant** | invoices without line items, balances and commissions blank |
| `branches`, `integrations`, `campaigns`, `offers`, `feedback`, `automation_rules`, `communication_logs`, `leave_requests`, `weight_logs`, `meals`, `diet_plan_meals` | studio features | **tenant** | each screen silently empty |
| `exercise_*`, `muscles`, `equipment_types` | shared exercise library | **tenant** | the 890-row library disappears — the exact trap `TENANT-RLS-PLAN.md` warns about |
| `platform_*`, `ai_platform_settings`, `ai_model_rates`, `system_logs`, `system_alerts`, `storage_accounting_meta` | platform console, workers | owner | **safe** — but only because of the owner pool |
| `clients`, `members`, `member_memberships`, `payments`, `attendance`, `bookings` | legacy v3 tables, empty in production | tenant | no effect today; a landmine if ever populated |

The pattern that matters: **a table is only safe if every path that reads it is
platform-wide or pre-auth.** Anything a studio user's request touches breaks, and
breaks silently, because RLS filters rather than errors.

### Ownership paths — **[verified]** (§6)

None of these carries `organization_id`. Read off the live schema:

```
ai_messages      → conversation_id → ai_conversations → user_id  → users.organization_id
ai_conversations → user_id                                       → users.organization_id
ai_usage_log     → user_id                                       → users.organization_id
notifications    → user_id                                       → users.organization_id
user_profiles    → user_id                                       → users.organization_id
refresh_tokens   → user_id                                       → users.organization_id
invoice_items    → invoice_id      → invoices.organization_id
session_balance  → client_id       → pt_clients.organization_id
pt_commissions   → trainer_id / client_id → trainers / pt_clients .organization_id
bookings         → client_id / member_id  → pt_clients / members
attendance       → member_id / branch_id  → (legacy, empty)
branches         → id only — no ownership path in the schema at all
feature_flags, system_settings, notification_log — no *_id columns; catalogue/log shaped
```

Every one of those is expressible as an `EXISTS` policy in the shape migration
159 already uses for its child tables, so **no schema change is required** for
them — which is the answer to §7. `branches` is the exception worth a decision:
it has no ownership path in the schema, and inventing one is a design question,
not a migration.

**Nothing here has been implemented.** Writing ~60 policies is a migration of its
own, it needs each ownership path argued individually, and §7 says stop and
report before touching schema. This is that report.

### The query that settles it

Run as any superuser against the target database.

What is provable from the migrations:

1. `131_close_rls_gaps.sql` enables RLS on **every base table in `public`**, by
   sweeping `pg_class` — not a named list.
2. `157` creates `app_tenant` policies **only** for tables carrying an
   `organization_id` column.
3. `159` creates policies for one enumerated set: `organizations`, three
   platform catalogues, and five child/grandchild tables.
4. A table with RLS enabled and no applicable policy **does not raise. It
   returns zero rows.**

So any table that is RLS-enabled, carries no `organization_id`, and is absent
from `159`'s list is denied to `app_tenant` after the cutover — silently.

These qualify on all three counts and are read by live features:

| Table | Read by | Consequence after cutover |
|---|---|---|
| `notifications` | the notification bell (`notifications.service.js` inbox/markRead) | bell goes permanently empty |
| `notification_log` | delivery audit | delivery history disappears |
| `ai_usage_log` | `requireAiQuota`, `getUserUsage` | quota reads 0 used ⇒ **enforcement fails open** |
| `ai_conversations`, `ai_messages` | AI Coach history | conversations vanish |

`ai_usage_log` having no `organization_id` is not an oversight — it is stated in
`126_ai_control_centre.sql:79` ("every per-studio figure joins through users").

**This contradicts `159`'s own header**, which says only *eleven* tables were in
the RLS-enabled-with-no-policy state, verified against a real database. Either
that inventory is narrower than its prose claims, or something grants access
that static reading cannot see. Both are possible; neither is safe to assume.

Settle it by asking the database, not the migrations:

```sql
-- Every table that will read zero rows as app_tenant.
SELECT c.relname AS table_name, c.relrowsecurity AS rls_on
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'r'
   AND c.relrowsecurity
   AND NOT EXISTS (
     SELECT 1 FROM pg_policy p
      WHERE p.polrelid = c.oid
        AND 'app_tenant'::regrole = ANY (p.polroles)
   )
 ORDER BY 1;
```

Anything that returns which the application actually queries needs a policy in a
new migration **before** stage 4. Tables nothing queries should be left denied —
that is the fail-closed answer for a table with no traffic to validate a policy
against, and it is the reasoning `159` already applies to `agent_tasks` and
`agent_audit_log`.

---

## Cutover procedure

Adapted to the infrastructure that exists: one VPS running docker compose, one
Supabase project, no staging. Do not invent environments for it.

| Stage | Action | Exit criterion | Reversal |
|---|---|---|---|
| **1** | Local: `scripts/rls-proof-setup.sh` (stands up extensions, roles, schema, all migrations, the `app_tenant` role — known-good), then `scripts/seed-e2e.js` with **≥2 organizations** carrying overlapping-shaped data | schema + role up, two tenants seeded | drop the database |
| **2** | Supabase **branch** off production. Not a VPS, not a second box. | branch reachable, migrations applied | delete the branch |
| **3** | **Run the inventory query above as `app_tenant`.** Produce the authoritative gap list; write a migration for every table the app queries. | query returns nothing the app reads | n/a — read-only |
| **4** | Run the E2E suite **twice** against the branch — once as `postgres`, once as `app_tenant` — and **diff the responses** | no unexplained differences | n/a |
| **5** | `TENANT_RLS_ENFORCE=on` against the branch. Collect three lists: every `tenant_scope_gap` warning, every permission error, every endpoint newly returning empty | all three empty | flag off |
| **6** | Tenant isolation: A→A allow, A→B deny, and `x-org-id` / body / param / JWT manipulation refused (`e2e/tenant-isolation.api.spec.ts` already asserts these) | green as `app_tenant` | n/a |
| **7** | Platform verification: `super_admin` reads cross-tenant **via the owner pool** with `ADMIN_DATABASE_URL` set to an owner role; `admin`/`trainer`/`staff` denied platform routes | green | n/a |
| **8** | **Rehearse the rollback.** Repoint `DATABASE_URL` back to the owner role, confirm full recovery, and time it. | recovery proven and timed | this *is* the rehearsal |
| **9** | Production, **flag first**. `TENANT_RLS_ENFORCE=on` alone, with `ADMIN_DATABASE_URL` already set. Watch `tenant_scope_gap` and latency. Only when quiet, repoint `DATABASE_URL`. | — | one env var + restart, at either step |

Step 4's diff is the important one and the easiest to skip. RLS denies by
**filtering**, not by erroring, so the dangerous failures are endpoints that
return `200 []` instead of `200 [rows]`. Nothing in the logs distinguishes that
from a genuinely empty result; only a comparison against the same run on the
other role does.

### Before stage 9, two things must be true that are not code

- **`ADMIN_DATABASE_URL` must be set to an owner-role connection string.** Until
  it differs from `DATABASE_URL`, `SEPARATE_ADMIN_CONNECTION` is false and
  `useOwnerConnection()` never fires — so the platform console, every worker and
  every pre-auth route would fall onto `app_tenant` and read nothing. This is the
  single most likely way to turn the cutover into an outage.
- **The authoritative compose file is `/opt/myptstudio/docker-compose.yml`, not
  the one in this repo**, and the two have already drifted (`api` here vs
  `backend` there). Env-var changes must be made on the box.

---

## Connection selection — `ADMIN_DATABASE_URL` — **[verified]**

```
                    every query goes through db/pool.js
                                   │
                    useOwnerConnection() ?
                    TENANT_RLS_ENFORCE          (env, boot-time)
                  && SEPARATE_ADMIN_CONNECTION  (env, boot-time)
                  && isPlatformWide()           (AsyncLocalStorage)
                                   │
              ┌────────── yes ─────┴───── no ──────────┐
              ▼                                        ▼
   PLATFORM / WORKER / PRE-AUTH                 TENANT REQUEST
   ownerPool()                                  pool  (DATABASE_URL)
   ADMIN_DATABASE_URL                           connects as app_tenant
   owner role, BYPASSRLS                        BEGIN
              │                                 set_config('app.org_id', …, true)
              ▼                                 │
   platform data, every studio                  ▼
                                                RLS filters to one studio
```

`isPlatformWide()` is true in exactly two cases (`lib/tenant-context.js:86-89`):
**no ALS store at all** — workers, cron, migrations, the startup probe, and every
unauthenticated route, since only `auth` opens a store — or a store explicitly
marked `platformWide`.

**Can a tenant user reach the owner pool?** No, and the reason is structural.
`platformWide` is set in exactly one place, `middleware/auth.js:208`:

```js
const platformWide = req.user.role === 'super_admin' && orgId == null;
```

`req.user.role` is loaded from the database on the request, never from the token
body, a header or a query parameter. A `super_admin` who names a studio via
`x-org-id` resolves a non-null `orgId` and is scoped like anyone else. There is
no request-controlled input anywhere in the decision.

| Question (§9) | Answer |
|---|---|
| Configured anywhere in the repo? | **No.** Absent from `.env.example`, `docker-compose.yml`, both workflow files. Read only at `db/pool.js:176`. |
| Server-only? | **Yes.** Backend `process.env`, never `NEXT_PUBLIC_*`. Frontend cannot see it. |
| Can a tenant user influence which connection is chosen? | **No** — see above. |
| Can a request manipulate `useOwnerConnection()`? | **No.** All three inputs are boot-time env or server-derived role. |
| If missing? | Falls back to `DATABASE_URL`, so `SEPARATE_ADMIN_CONNECTION` is false and `useOwnerConnection()` never fires. Harmless **today**; catastrophic **after** the role switch — see below. |
| If equal to `DATABASE_URL`? | Identical to missing. This is the current state, and it is why the whole mechanism is inert. |
| When `DATABASE_URL` becomes `app_tenant` and this is still unset? | **Every platform read returns zero rows.** The console, every worker, the renewal sweep and every pre-auth route fall onto `app_tenant` with no `app.org_id`, matching no policy. Login would fail to find accounts that exist. |
| Safe as designed? | **Yes** — provided it is set *before* the role switch, never after. |

**This is the single most likely way to turn the cutover into an outage**, and it
is ordering, not code: `ADMIN_DATABASE_URL` must be live and proven (stage 7)
while `DATABASE_URL` still points at the owner role.

## Worker and queue context (§10) — **[verified]**

Workers reach the owner pool by having no ALS store. That is correct **only
because they are trusted infrastructure running server-authored jobs**, and it
means a worker does not inherit the tenant identity of whoever enqueued the job.

Phase 1 addressed that where it matters: the notifications queue now carries the
organization from server context and the worker **re-derives the recipient's
authoritative organization from the database** before delivering, refusing and
auditing a mismatch (`assertJobTenant`). So a tenant-originated job does not
silently become platform-wide — it is checked against the row, not the payload.

| Queue | Kind | Tenant context | Verified by |
|---|---|---|---|
| `notifications` | tenant | stamped at enqueue, **re-derived at processing** | `queue.tenantContext.test.js`, `notifications.broadcast.integration.test.js` |
| `ai` | tenant | re-derived from the document row (`knowledgeBase.js`) — the original good pattern | pre-existing |
| `email`, `whatsapp` | tenant, address-shaped | carried for traceability, deliberately not gated: no row to re-derive from, and `password_reset` / `admin_otp` / `admin_invitation` are pre-auth with no organization | `queue.tenantContext.test.js` |
| `membership-renewals` | **platform** | none, declared `scope: 'platform'` | `renewal.worker.js` |

The distinction is now explicit rather than inferred: a job with no organization
is either declared platform, or a legacy job from before the change — it is never
an unmarked tenant job that quietly lost its scope.

## Blockers

1. **~60 tables have no `app_tenant` policy** and are read by live tenant
   traffic. This was blocker 2 ("the inventory is untrustworthy"); the inventory
   has now been taken, and it turned a question into the largest piece of
   remaining work. Ownership paths are proven; the migration is unwritten.
2. **No staging environment.** `STAGING-PLAN.md` Option A — an ephemeral Supabase
   branch driven by the E2E suite that already exists — remains the right path,
   and its reasoning holds: the failures being hunted are found by request
   coverage. Needs account access, not code. The local proof database built by
   `rls-proof-setup.sh` substitutes for the *database* half of that rehearsal but
   not for the *application* half: nothing here has run the API end to end
   against an RLS-enforcing database.
3. **The `tenant_scope_gap` list has never been produced.** Unchanged. It is the
   known-unknowns list, and it stays empty until the API runs with the flag on
   under real request coverage.

Blocker 1 is new information, not a new problem: it was always true, and
159's header said otherwise.

## Conditions

- **C1 — OPEN, and now the whole job.** ~60 tables need policies. Ownership paths
  are proven above and all but `branches` fit migration 159's existing `EXISTS`
  shape, so no schema change is required — but the migration itself is unwritten.
- **C2 — OPEN.** `ADMIN_DATABASE_URL` set, and stage 7 proving platform reads.
- **C3 — CLOSED.** `tenantContext.concurrency.integration.test.js` demonstrates it
  against the real pool, the real ALS plumbing, the real `app_tenant` role and
  the real policies: 40 interleaved requests, a 100-request random burst, a
  2-connection pool forcing reuse, plus mid-transaction throws and failed
  statements. No leakage. A context-less request reads **zero** rows rather than
  everything, which is the fail-closed direction.

  It also **found a real defect**: `scopeClient` cached pg-pool's per-acquisition
  `release` closure on the client, so the second borrow of any reused connection
  threw *"Release called on client which has already been released to the pool."*
  With the flag on, that broke every `pool.connect()` → `BEGIN` … `COMMIT` path —
  payments, invoices, enrolment. It survived because the existing unit test
  exercises `scopeClient` against a hand-rolled fake, and a fake has no reason to
  reassign `release` per acquisition. Fixed; mutation-verified.
- **C4 — OPEN.** Per-query transaction latency still unmeasured.

## What guards the gap meanwhile

`tenantScope.convention.test.js` fails the build when a file queries a tenant
table without referencing the boundary. It is coarse by design and was
mutation-tested. As its own plan says: that is a ratchet against new mistakes,
not a backstop under existing ones. It makes the omission loud; it does not make
the database safe.
