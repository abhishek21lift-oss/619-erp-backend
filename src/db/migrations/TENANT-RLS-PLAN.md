# Database-level tenant isolation — verified design and why it is not a migration yet

Audit finding C-2. This document exists because the fix is a project, not a
patch, and the half of it that is already settled should not have to be
rediscovered.

## What was verified against production

Run against the live `619-erp` project (`adffjnztzrolibtuvhgc`), not inferred:

| Check | Result |
|---|---|
| Role the API connects as | `postgres`, `rolbypassrls = true` |
| RLS policies in `public` | 247 |
| …that are organization-scoped | **0** |
| Live tenants | 6 studios, all with real client/payment data |
| Tables carrying `organization_id` | 55 |
| `pt_clients` / `pt_payments` / `pt_assessments` / `attendance_logs` / `trainers` rows with NULL `organization_id` | **0** |

Two conclusions follow. First, the finding is real: every existing policy is a
deny-all for the PostgREST `anon`/`authenticated` roles, which protects against
a leaked publishable key and does nothing about this API — the app's role
bypasses RLS entirely. Second, the application-layer scoping is genuinely
working today; the core business tables have no orphaned rows. The exposure is
not a known leak, it is the absence of a backstop under 839 query call sites.

## The policy design, and the trap in it

Not every NULL `organization_id` is a bug. Verified counts:

| Table | Rows | NULL org | Meaning |
|---|---|---|---|
| `exercises` | 890 | **890** | shared exercise library every studio draws from |
| `muscle_volume_landmarks` | 12 | 12 | reference data |
| `diet_templates` | 8 | 8 | shared templates |
| `login_events` | 322 | 131 | failed logins, no user identified yet |
| `users` | 8 | 1 | the platform super-admin, who has no org by design |

A naive `USING (organization_id = current_setting('app.org_id'))` applied
across the board would empty the 890-row exercise library for all six studios
simultaneously. Tenant tables and platform-global tables need different
policies:

```sql
-- Strict tenant table (pt_clients, pt_payments, attendance_logs, …)
CREATE POLICY tenant_isolation ON public.pt_clients FOR ALL TO app_tenant
  USING      (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));

-- Table with shared platform-global rows (exercises, diet_templates, …)
CREATE POLICY tenant_isolation ON public.exercises FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true)
         OR organization_id IS NULL);
```

Both shapes were prototyped against production inside a transaction that was
rolled back. Acting as Abhishek PT Studio the strict policy returned 12 of 29
`pt_clients` — exactly that studio's real count — while the shared policy still
returned all 890 exercises. The design works; nothing was left behind.

### The GUC caution

Migration `131_close_rls_gaps.sql` dropped four `current_setting()`-based
policies precisely because they were granted to `public` FOR ALL: nothing set
the GUC, so they denied by accident, and anyone who *could* set it got
everything. This design must not repeat that. The policies above are granted
**only** to a dedicated `app_tenant` role, never to `public`, `anon`, or
`authenticated`, and the existing deny-all policies stay exactly as they are.

## Why this cannot ship as a migration alone

RLS is only enforced if two further things are true, and neither is a database
change:

1. **The API must stop connecting as `postgres`.** A new `app_tenant` role
   without `BYPASSRLS` has to be created, granted table privileges, and put in
   `DATABASE_URL`. That is a deployment change, and it is one-way in the sense
   that every privilege the app relies on has to be granted explicitly or
   requests start failing.

2. **`app.org_id` must be set per request, on the connection running the
   query.** `SET LOCAL` is transaction-scoped, and the app runs 839
   `pool.query()` calls that each borrow a fresh pooled connection with no
   surrounding transaction. Supavisor in transaction mode (port 6543) makes
   session-level `SET` unusable, so the setting has to ride inside an explicit
   transaction.

Rewriting 839 call sites is not the answer. The tractable approach is
`AsyncLocalStorage`: the auth middleware puts the resolved org id into an ALS
store, and `db/pool.js` wraps `query()` to acquire a client, `BEGIN`,
`SET LOCAL app.org_id`, run, `COMMIT`. No call site changes. The costs are real
and must be measured before rollout — every read becomes a transaction, which
adds round trips, and the existing explicit-transaction paths (`pool.connect()`
in payments/invoices) need to opt out of the wrapper rather than nest.

## Rollout order

1. ~~Land the ALS org-context plumbing behind an **off-by-default** flag, so it
   ships dark and changes nothing.~~ **Done** — `lib/tenant-context.js` and the
   `db/pool.js` wrappers. Note the flag is no longer off by default: it defaults
   ON and is disabled only by the exact string `off`.
2. ~~Create `app_tenant` + policies in a staging branch (Supabase branching), and
   run the full suite against it with the flag on.~~ **Done** — migrations 157,
   159, 161, 174. CI stands the whole thing up per run via
   `scripts/rls-proof-setup.sh` and runs `rls.isolation.integration.test.js`
   against it as a real `app_tenant` connection.
3. ~~Measure the added latency from per-query transactions.~~ **Done** —
   `src/__tests__/rls.overhead.integration.test.js`, against the same real
   `app_tenant` database CI already stands up. The answer, and the reason it
   is stated as a count rather than a duration:

   > The wrapper turns one round trip into **four** — BEGIN, set_config, the
   > query, COMMIT — and a tenant query takes about **3× as long**. Measured
   > against the proof database: unwrapped 0.552 ms, wrapped 1.659 ms, added
   > 1.107 ms, ratio 3.0×.
   >
   > The count is the part that travels. BEGIN and COMMIT are cheaper to
   > execute than a real SELECT, so on a fast link the added cost is nearer 2×
   > one query's time than 3× — but as RTT grows the three extra trips
   > dominate and **added ≈ 3 × RTT** becomes the accurate model. Localhost is
   > therefore the floor, not the estimate. At 1 ms RTT expect about +3 ms per
   > tenant query; through a cross-region Supavisor hop at 15 ms, about +45 ms.

   CI measures on localhost, where a round trip is tens of microseconds, so
   the duration it prints understates production by roughly the ratio of the
   two RTTs — which is exactly why the assertion is on the count and the
   timings are printed with the caveat attached rather than asserted.

   So step 3's "if it is material" resolves on one number the operator has and
   CI does not: the app's RTT to the database. Measure that first. If it is
   low single-digit milliseconds, the flat cost is tolerable and the wrapper
   can stay as it is. If it is not, scope the wrapper to reads of tenant
   tables before step 5 rather than after.
4. **Set `ADMIN_DATABASE_URL` before touching `DATABASE_URL`.** This was not in
   the original list and it is now a hard precondition: platform-wide work
   (the operator console, every background worker, migrations, the pre-auth
   routes) has no org and so matches no policy. Without a separate owner
   connection those go silently empty rather than erroring. `server.js` refuses
   to boot if enforcement is on and the two URLs are the same — that check
   exists, but note it was inverted until recently and did not fire in the
   default configuration, so do not treat a clean boot on an older build as
   evidence of anything.
5. Switch staging's `DATABASE_URL` to `app_tenant`. Fix every permission error
   that surfaces — this is the step that finds what the app quietly relied on.
   Expect *silence* as well as errors: RLS denies by filtering, so the failure
   mode to look for is a screen that renders empty, not a 500.
6. Only then, production.

## What this costs today

With `TENANT_RLS_ENFORCE` defaulting on and `ADMIN_DATABASE_URL` unset,
`db/pool.js` wraps every tenant query in `BEGIN → set_config → query → COMMIT`
on a dedicated pooled client — four round trips instead of one, holding one of
twenty connections for the whole transaction. Meanwhile the app connects as
`postgres`, which owns the tables and therefore bypasses every policy the
wrapper is feeding. Pure overhead, buying nothing.

**In production that state is now unreachable**: `server.js` refuses to boot
when `isProd && rlsEnforcementEnabled()` and the two URLs are the same. So a
production box is necessarily in one of two configurations — enforcement
switched `off`, or `ADMIN_DATABASE_URL` already split out — and neither pays
for nothing. The paragraph above still describes staging and development,
where `isProd` is false and the guard does not run.

The ordering matters in both directions: until the cutover, enforcement is
overhead; after it, it is the backstop.

## What guards the gap until then

Two tests, and they ask opposite questions on purpose.

`src/__tests__/tenantScope.convention.test.js` fails the build when a file
queries a tenant table without referencing the tenant boundary. It is coarse by
design (file-level and per-handler, not per-query) so it does not cry wolf on
correct code, and it was mutation-tested: a route added with `SELECT id, name,
mobile FROM pt_clients` and no filter is caught.

**It derives its table list from the migrations by scanning for
`organization_id` — which is a blind spot, not the coverage this document
previously claimed.** A table that never received the column is not merely
unprotected; it is, by that test's own definition, *not a tenant table*, so the
test never looks at it. Migration 157's policy generator discovers its policy
list exactly the same way and is blind in exactly the same place. Twelve tables
sat in that gap — campaigns, offers, feedback, integrations, plans, meals,
pt_packages, session_balance, automation_rules, communication_logs and the two
assessment tables — every one of them read and written with no tenant filter at
all, on every commit, past a green suite.

`src/__tests__/tenantColumns.convention.test.js` closes that loop by asking the
inverse: *for each table the application reads, does it carry `organization_id`
— and if not, is it on a list where a human wrote down why that is safe?* A new
table with neither fails the build. It also requires that every INSERT into a
retrofitted table names the column, because scoping the reads and forgetting
the writes is its own failure and happened once already.

Together they are a ratchet against new mistakes, not a backstop under existing
ones. They do not make the database safe; they make the omission loud. The
backstop is step 6.
