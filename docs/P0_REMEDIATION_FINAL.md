# P0 Remediation — final report

**Branch:** `claude/supabase-access-4l6gc3` (both repositories)
**Backend:** 6 commits · **Frontend:** 2 commits
**Backend suite:** 2130/2131 passing · **Frontend suite:** 1566/1566 passing
**E2E cross-tenant isolation:** 23/23 against a real API and database

---

## Read this first

**Two things in this report are not fixed by any commit, and both need you.**

1. **The live platform super-admin password is published.** Its bcrypt hash was
   committed to a **public** repository and is byte-identical to the one in
   production, on an active account with cross-tenant authority over all six
   studios and MFA disabled. The working tree is cleaned and a rotation script
   is provided, **but the credential is still live until you rotate it.**
   Runbook: `docs/SECURITY-INCIDENT-superadmin-credential.md`.

2. **There are no database backups.** The Supabase organisation is on the free
   plan, which Supabase does not back up at all — no daily backups, no PITR, no
   restore point. A backup script is provided and verified end to end, **but it
   is not scheduled anywhere, so today's exposure is unchanged.**
   Details: `docs/DISASTER-RECOVERY.md`.

**Production status: 🔴 NO-GO** until (1) is rotated and (2) is scheduled.
Neither is a code change; both are operator actions, and both were flagged
rather than performed because they alter live credentials and infrastructure.

## A note on the source audit

No document in either repository matched the "grade B−, conditional NO-GO"
audit this remediation was written against — searched both repos for
`mark-all-paid`, `leave_requests`, the super-admin hash language, `BYPASSRLS`
and `NO-GO`. The repos carry *other*, different audit documents
(`BACKEND-FRONTEND-AUDIT.md`, `619-erp-frontend/AUDIT-REPORT.md`,
`FULLSTACK-AUDIT.md`) covering different findings.

So every item below was **re-derived from the current code, schema and live
database**, per the remediation's own rule not to trust the prior audit. That
mattered: two of the prompt's hypotheses were wrong as stated (§8, §12), one
finding was inert rather than live (§9), and three defects were found that the
prompt did not mention at all (§2b, §7b, §8).

---

# Findings

## 1. `mark-all-paid` updated every studio's payouts — FIXED

**Before.** `POST /api/pt-os/payouts/mark-all-paid` ran
`UPDATE pt_payouts SET status='paid', paid_at=NOW() WHERE month=$1 AND status != 'paid'`
with no organization predicate anywhere.

**Verification.** Confirmed by reading the handler. Any admin in any studio
marked every studio's pending payouts for the month paid, moving `paid_at` and
`status` for money they never touched.

**Fix.** Scoped through `tenantScope()` with
`trainer_id IN (SELECT id FROM pt_trainers WHERE organization_id = $N)` —
`pt_payouts` has no `organization_id` of its own; the tenant boundary runs
through `trainer_id`. Uses the file's existing `orgWhere()` helper; no new
tenant machinery.

**Migration.** None — no schema change needed.

**Test.** `src/__tests__/ptOs.payouts.tenantIsolation.test.js` (11 tests,
asserts the literal SQL and bound params). Plus E2E
`mark-all-paid does not touch B's payout`, which reads B's status back **as B**.

**Result.** 9/11 failed pre-fix, 11/11 pass after. E2E green.

**Security impact.** Closes cross-tenant financial write.

**Regression risk.** Low — narrows an existing query with a predicate already
used by its siblings.

## 2. The rest of the payout/commission surface was equally unscoped — FIXED

**Before.** `PUT /payouts/:trainerId`, `POST /payouts/:id/approve`,
`POST /payouts`, `GET /payouts`, `GET /commissions`,
`POST /commissions/calculate` — none scoped by organization.

**Fix.** A `scope` parameter threaded into all five service functions;
cross-tenant ids now `404` rather than silently matching nothing, matching the
file's existing convention.

**Test.** Same suite as §1, plus five E2E attacks.

**Regression risk.** Low, with one residual: `PUT /payouts/:trainerId` guards
with a pre-check `SELECT` rather than a predicate on the `UPDATE` itself
(mirroring `PUT /commissions/:trainerId`). Correct under normal use; a
predicate on the write would be strictly better.

### 2b. `commissions/calculate` was broken outright — FIXED (not in the prompt)

`NULLIF(c.pt_end_date, '')::DATE` on a `date` column forces Postgres to coerce
`''` to `date`, which fails **at plan time**, before any row is read. The
endpoint therefore 500'd unconditionally — verified in production's
`information_schema` that `pt_end_date` is `date` there too, so it has never
worked. Found because the E2E suite called it. Fixed by dropping the `NULLIF`;
the `IS NULL` arm already covers a null end date.

## 3. `/api/leave` had no tenant boundary at all — FIXED

**Before.** `leave_requests` had no `organization_id` since `001`, so the four
handlers could not be scoped even in principle. `adminOrManager` is a **role**
gate — it answers "may this person approve leave", never "whose leave" — so any
studio's admin or manager could list every studio's requests (with trainer
name, email and mobile via the `LEFT JOIN`), read any by id, and **approve or
reject another business's staffing decisions**.

**Migration.** `168_leave_requests_organization_id.sql` — adds the column, FK
and index; backfills from the trainer (`trainer_id` is `NOT NULL` and
FK-enforced, so exactly one owner per row); tightens to `NOT NULL` only if zero
NULLs remain (the conditional shape of `155`/`160`, so a data-quality problem
cannot take a deploy down); and adds the strict `app_tenant` RLS policy —
`157` builds its policy list by scanning for `organization_id` *at the time it
runs*, so a column added later gets none, and a table with RLS enabled and no
policy returns **zero rows silently** after the cutover. That is exactly the
gap `159` was written to close for eleven other tables.

**Verified against a real database**, not asserted: throwaway Postgres 16, full
schema, all 168 migrations — applies cleanly, idempotent on re-run, backfill
attributes each request to its trainer's studio, and as `app_tenant`, Studio A
sees only its own row, A's `UPDATE` of B's leave affects **0 rows**, B stays
`pending`, and a connection with no `app.org_id` sees **nothing**.

**Test.** `src/__tests__/leave.tenantIsolation.test.js` (13 tests) — 12 fail
pre-fix. Plus six E2E leave attacks.

**Not yet applied to production.** Migration 168 is committed and unapplied;
applying DDL to the live database is the operator's call. It runs on the next
deploy via the existing `npm run migrate` step.

## 4. The super-admin credential is published — CONTAINED, ROTATION OUTSTANDING

**Verification (the strongest evidence in this report).** SHA-256 fingerprint
of the hash in migration `131` compared against `digest(password,'sha256')` for
the production row — **identical** (`286f9ac1…`). Neither value was ever
printed. The account is `is_active`, holds cross-tenant authority via
`platform_owners`, and `user_profiles.mfa_enabled = false`. The repository is
**public** (`"private": false` via the GitHub API).

**Fix (containment only).** Both hashes replaced with a locked placeholder — a
valid bcrypt string of `.` padding that no input matches, asserted by test.
A no-op for every existing database: `091` is guarded by `WHERE NOT EXISTS`,
`131` matches the *old* address and stops matching after its first run, and the
runner does not checksum applied migrations.

`scripts/rotate-super-admin-password.js` reads the password from a no-echo
prompt or env (never argv), refuses weak input, verifies the hash validates
*before* writing so a rotation cannot lock the account, and bumps
`token_version` to invalidate every existing session. Exercised end to end.

`src/__tests__/noCommittedSecrets.test.js` fails the build if a bcrypt hash is
committed — verified by planting one (caught, file named, hash never printed).

**Still outstanding, and yours:** rotate the password, enable MFA, make both
repositories private, decide on history. Redaction does **not** un-publish the
old hashes; only rotation removes their value.

## 5. Security controls failed open — FIXED

**Before.** `TENANT_RLS_ENFORCE`, `PLATFORM_SESSION_ENFORCE` and
`SUPER_ADMIN_REQUIRE_MFA` each read as an exact `=== 'on'` comparison, and
nothing noticed when they were unset. Production booted clean and served
traffic with all three silently disabled.

**Fix.** Production refuses to start unless each is exactly `on`, naming each
disabled control and what it protects, printing no values. The strict
comparison is preserved (`!== 'on'` is its negation) — the test asserts it was
not relaxed to `Boolean()`/`!!`/`??`.

**Verified by booting the server:** all three unset → refuses and names all
three; one set → names the remaining two; `TENANT_RLS_ENFORCE=true` → correctly
rejected; development still starts.

**Before you deploy this**, read the header of `src/server.js`. Each flag has a
prerequisite. In particular **`SUPER_ADMIN_REQUIRE_MFA=on` will lock out your
only platform account** — `mfa_enabled` is currently `false`. Enable MFA first.

## 6. The app connects with BYPASSRLS — CONFIRMED, cutover is an operator action

Verified in production `pg_roles`:

| role | `rolbypassrls` | `rolcanlogin` |
|---|---|---|
| `postgres` (what `DATABASE_URL` uses) | **true** | true |
| `app_tenant` | **false** | true |

So the audit's claim is correct — RLS is currently inert for the API — and it
is deliberate and documented (`TENANT-RLS-PLAN.md`). **The safe least-privilege
role already exists in production**, correctly configured `NOBYPASSRLS
NOSUPERUSER`, with 72 `tenant_isolation` policies granted to it and RLS enabled
on every table in `public`.

Remaining is not code: set a password on `app_tenant`, point `DATABASE_URL` at
it, keep `ADMIN_DATABASE_URL` as `postgres` for platform-wide work, and turn on
`TENANT_RLS_ENFORCE`. Deliberately **not** done here — changing production DB
roles blindly is what this remediation was told not to do. The isolation is
already proven: `rls.isolation.integration.test.js` passes 23/23, and it had
**never run in CI before** (its `RLS_TEST_DATABASE_URL` was unset).

## 7. `member_id` vs `pt_client_id` — FIXED, but not as the prompt described

**The prompt's hypothesis was wrong for one of the four files it named**, which
is why each site was traced to the table it queries before being touched.

`users` carries two links: `pt_client_id → pt_clients` (live) and
`member_id → clients` (legacy, 0 rows). Client accounts are role `member` with
`pt_client_id` set and `member_id` **NULL** — verified in production.

| Site | Verdict |
|---|---|
| `upi-payments.js` ×4 | **Broken.** Clients 404'd on their own payment, 403'd `NO_MEMBER` before starting one, always got an empty history, and `userIdForClient` returned null every time — so **every payment notification was silently dropped**, admin verifications included. |
| `payments.js` ×2 | **Broken.** `LEDGER_SQL` unions `pt_payments` (pt_clients space) with legacy `payments` (clients space); the clamp used `member_id` alone, so a client's list was empty while all live money sat in `pt_payments`. Now matches **either** id, nulls filtered — an account linked to neither matches nothing. |
| `clients.js` ×1 | **Broken.** Compared a `pt_clients` row id to `member_id`, 404ing a client asking for their own record. |
| `rbac.js` `requireSelfOrRole` | **Latent** — mounted nowhere. Corrected so wiring it up won't 403 real accounts. |
| `rbac.js` `requireClient` | **Already correct.** Left alone: the client role *is* `member` here. |

**None of these leaked.** Every one fails closed — they locked clients out of
their own data rather than letting anyone into someone else's.

**Test.** `src/__tests__/clientAccount.idSpace.test.js` (12 tests) — 8 fail
pre-fix.

## 8. CI/CD — the nested workflow was inert; the real gap was elsewhere

**The prompt's suspicion was half right.**
`.github/workflows/workflows/deploy.yml` *is* a stale pre-gating copy that
triggers on `push: main` with no CI gate — but GitHub Actions does not recurse
into subdirectories of `.github/workflows`, so **it never ran**. Confirmed
against the API: exactly three workflows are registered. Deleted anyway; it is
a copy of the deploy path with the gate missing, one directory move from
becoming real.

**The actual gap was in the frontend.** The `E2E — cross-tenant isolation` job
carried `continue-on-error: true` — the one suite proving studios cannot read
each other's data could fail while CI concluded success, and `deploy.yml` gates
on that conclusion. So a cross-tenant regression would have shipped with a
green tick.

Now blocking, and `build` `needs` it. Its stated blocker — a cross-repo PAT for
a private backend — no longer applies, because the backend repo is public.
**Made blocking only after running the suite for real** (23/23), not on the
assumption that it passes.

## 9. Tenant-isolation regression suite — EXTENDED

Was 8 tests over clients, payments, invoices and header-widening. Now **23**,
adding payouts, commissions, leave, and reporting aggregates — every route this
remediation touched, written as attacks. The decisive assertions read the
victim's state back **as the victim**, so a check cannot pass because the read
itself leaked.

Of the eleven areas the prompt listed, **nine** are covered. **Inventory** has
no corresponding module in this codebase. **AI** is covered only indirectly
(`revenue`, `trainer-performance`, `balance-sheet`); a direct "Org A's AI agent
cannot retrieve Org B's client" test needs an AI provider key the sandbox does
not have and is the clearest remaining gap in the suite.

## 10. Data integrity — CLEAN

Ten checks against production, all zero: duplicate migrations, orphaned leave
requests, payouts with a missing trainer, commissions with a missing client,
NULL `organization_id` on `pt_clients`/`pt_trainers`/`pt_payments`, users with
both id links, duplicate `(trainer, month)` payouts, and payouts marked paid
with zero commission.

## 11. Performance — one of four

**M-09 done.** The sidebar rebuilt its whole nav tree on every render, and it
re-renders on every navigation (it reads `usePathname()`), so each route change
re-ran three predicates for every item and child. Now memoized on what it
actually reads.

**H-11 not reproduced.** The claim is Recharts loading via the UI barrel on the
authenticated root. Neither the root layout nor the sidebar imports the barrel
— the sidebar deep-imports `@/components/ui/cn`. Whatever the original finding
measured, it is not visible at the stated location, so nothing was changed on
the strength of it.

**H-12 and M-10 not attempted.** Reducing framer-motion in the shell and adding
server-side pagination to three endpoints are behaviour-affecting refactors,
and this sandbox has no way to measure a before/after. Doing them blind, at the
end of a security pass, would have added regression risk to a branch whose
value is that its changes are verified. Left with the reasoning stated rather
than half-done.

---

# Scorecard

Scored on the state of the branch **as it would be after you complete the two
outstanding operator actions**; the parenthetical is today's score without them.

| Area | Score | Why |
|---|---:|---|
| Security | **72** (48) | Cross-tenant writes closed, controls fail closed, secret guard added. Held down by a published credential that is still live, and a public repository. |
| Tenant isolation | **88** | Every verified gap closed and proven against a real database. RLS exists but is inert until the `app_tenant` cutover, so isolation still rests on application SQL. |
| Database | **70** | Schema and integrity clean, migrations disciplined. No PITR, and 168 is not yet applied. |
| Authentication | **75** | Sound design — token_version revocation, audience claims, bcrypt cost 12. MFA is off on the one account that most needs it. |
| Authorization | **85** | Role and tenant gates now distinguished; the "role gate is not a tenant gate" confusion is fixed in all four places it appeared. |
| Financial integrity | **90** | The bulk-payout breach is closed and proven; commission recalculation works for the first time. |
| Testing | **86** | 2130 + 1566 + 23 E2E, isolation suite now blocking, RLS integration running for the first time. Gaps: AI isolation, one pre-existing failure. |
| Performance | **55** | One of four findings addressed; two not attempted, one not reproduced. |
| DevOps | **62** | Deploy correctly gated, rollback exists, dead workflow gone. **No database backups running** is the dominant term. |
| **Overall** | **76** (58) | |

## Production status

### 🔴 NO-GO today

Not because of the code on this branch — that is in materially better shape
than it was — but because of two facts no commit can change:

1. A live, MFA-less, cross-tenant administrator credential is published in a
   public repository.
2. Six studios' production data has no backup of any kind.

### 🟡 GO WITH CONDITIONS once you have

1. **Rotated the super-admin password** (`scripts/rotate-super-admin-password.js`).
2. **Enabled MFA** on that account.
3. **Made both repositories private.**
4. **Scheduled `scripts/backup-database.js`** on a real host, and confirmed a
   failure is visible to a person.
5. **Deployed this branch** — which applies migration 168 and turns on the
   startup guard. Set all three flags first; MFA (2) before
   `SUPER_ADMIN_REQUIRE_MFA=on`.

### 🟢 GO after, additionally

6. Supabase **Pro plan with PITR** — the stopgap's RPO is up to 24 hours.
7. The **`app_tenant` cutover**, so the database enforces isolation rather than
   trusting every query to remember its `WHERE` clause.

---

## What I did not do, and why

- **Did not rotate the live credential.** It needs a password only you can
  choose, and delivering one through this channel would be a fresh disclosure.
- **Did not apply migration 168 to production.** DDL against a live database is
  the operator's call; it applies on the next deploy.
- **Did not change production DB roles.** The `app_tenant` cutover needs a
  staging rehearsal, per the project's own plan.
- **Did not rewrite git history.** It rewrites published commits and cannot
  reach existing clones; rotation is what actually helps.
- **Did not attempt H-12 or M-10.** No way to measure here.

## Honest residuals

- `ai.textExtract.test.js` fails in this sandbox — a missing native
  `@napi-rs/canvas` binding, pre-existing and reproducing on unmodified `main`.
- `PUT /payouts/:trainerId` guards with a pre-check rather than a predicate on
  the write.
- The E2E suite is proven locally but **has not yet run in GitHub Actions**;
  the first CI run on this branch is the real test of the blocking change.
- Frontend lint carries 199 warnings against a 230 ceiling — untouched, but
  that ceiling is doing real work.
