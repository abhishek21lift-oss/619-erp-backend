# RLS cutover — readiness audit

Companion to `TENANT-RLS-PLAN.md`, which is the design and remains the source of
truth. This document does not propose a different architecture. It answers one
question the plan does not: **is the cutover safe to perform right now?**

**Verdict: NOT READY.** Three blockers, listed at the bottom. None is a defect in
the design — two are missing environment, and one is an inventory that cannot be
trusted without a live database to check it against.

Audited against `main` @ `3c841d2`. Everything below is read out of the
repository; nothing was run against a database, which is itself part of the
finding.

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

## The inventory problem

This is the finding that most needs settling before anyone touches
`DATABASE_URL`, and it cannot be settled by reading files.

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

## Blockers

1. **No staging environment.** `STAGING-PLAN.md` Option A — an ephemeral
   Supabase branch driven by the E2E suite that already exists — is the
   recommended path, and its reasoning holds: the failures being hunted are
   found by request coverage, and the existing suite has more of it than a human
   clicking through a staging box would. Needs account access, not code.
2. **The gap-table inventory is not trustworthy** (above). Needs one query
   against a real database as the real role.
3. **The `tenant_scope_gap` list has never been produced.** It is the known-
   unknowns list, and it is empty only because nothing has run with the flag on.

## Conditions, if the blockers clear

- **C1** — every table returned by the inventory query that the app queries has a
  policy, in a migration, tested.
- **C2** — `ADMIN_DATABASE_URL` is set and stage 7 proves platform reads work.
- **C3** — a concurrency test demonstrates two simultaneous requests for
  different organizations never see each other's `app.org_id`. The design makes
  this safe by construction; nothing has yet shown it empirically, and this is
  the assumption whose failure would be worst and quietest.
- **C4** — the added per-query transaction latency is measured. `TENANT-RLS-PLAN.md`
  step 3 asks for this and it has never been done; every read becoming a
  transaction is not free, and the answer may narrow the wrapper to tenant-table
  reads.

## What guards the gap meanwhile

`tenantScope.convention.test.js` fails the build when a file queries a tenant
table without referencing the boundary. It is coarse by design and was
mutation-tested. As its own plan says: that is a ratchet against new mistakes,
not a backstop under existing ones. It makes the omission loud; it does not make
the database safe.
