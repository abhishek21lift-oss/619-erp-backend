# P0 Remediation Tracker

Working log for the P0/P1 remediation pass. Each entry records what was
independently verified against the current codebase, what changed, and what
test proves it. See `docs/P0_REMEDIATION_FINAL.md` for the closing report
and scorecard once the full pass is complete — this file is the running log
kept up to date as work happens.

**Branch note:** this session's infrastructure binds pushes to
`claude/supabase-access-4l6gc3` in both `619-erp-backend` and
`619-erp-frontend`. That branch is being used as the remediation branch in
place of the `security/p0-remediation` name, to avoid diverging from the
session's configured PR tracking. All remediation commits land there.

**Source-of-truth note:** no document in either repository matched the
specific "B-, conditional NO-GO" audit this remediation prompt describes
(searched both repos for `mark-all-paid`, `leave_requests`, `super-admin`
hash language, `BYPASSRLS`, `NO-GO` — no hits). The repos do carry other,
different audit docs (`BACKEND-FRONTEND-AUDIT.md`,
`619-erp-frontend/AUDIT-REPORT.md`, `FULLSTACK-AUDIT.md`) covering different
findings. Per the remediation prompt's own rule ("do not blindly trust the
previous audit — verify every finding against the current code"), every
item below was independently re-derived by reading the live route, service,
and schema code, not copied from a prior report.

**Housekeeping:** removed a leftover `docs` file at repo root (a one-line
stub reading `<!-- This file moved to docs/ARCHITECTURE-v3.md -- delete
this stub -->`) that was blocking creation of the `docs/` directory this
tracker lives in.

---

## Phase 0 — Safety checkpoint

- Both repos cloned fresh, `main` @ clean working tree before any edit
  (`619-erp-backend` @ `c4bddeb`, `619-erp-frontend` @ `65c2bec`).
- No uncommitted work found in either repo at session start.
- Migration state: backend migrations live in `src/db/migrations/`
  (currently through `167_*`), tracked via `public._migrations` (184 rows
  applied per live Supabase inspection). No pending/unapplied migrations
  found in-tree beyond what's noted per-phase below.
- Environment: this sandbox has no `DATABASE_URL` / Redis configured, so the
  live app cannot boot here. Verification that a query is unscoped is
  therefore done by reading the route/service/schema code directly (and,
  where noted, by asserting on the literal SQL sent via a mocked
  `pool.query` in jest — the existing house convention, see
  `src/__tests__/ptOs.trainers.tenantIsolation.test.js`), not by exercising
  a live multi-tenant database.
- Supabase project confirmed via MCP: `619-erp` (`adffjnztzrolibtuvhgc`),
  Postgres 17.6, ap-south-1, ACTIVE_HEALTHY, ~185 tables in `public`, all
  RLS-enabled.

## Phase 2 + Phase 7 — Payout / commission tenant isolation (DONE)

**Verified, not assumed.** Read `src/modules/pt-os/pt-os.routes.js` and
`pt-os.service.js` directly.

### Findings confirmed

| Endpoint / function | Confirmed gap |
|---|---|
| `POST /payouts/mark-all-paid` | Bare `UPDATE pt_payouts SET status='paid' ... WHERE month=$1 AND status != 'paid'` — zero organization filter. Any admin marks every studio's pending payouts for the month paid in one call. |
| `PUT /payouts/:trainerId` | No role-tenant check on `:trainerId` at all — any admin can rewrite any other studio's payout row by trainer id. |
| `POST /payouts/:id/approve` → `markPayoutPaid()` | `UPDATE pt_payouts ... WHERE id=$1` — payout id from any studio accepted. |
| `POST /payouts` → `createPayout()` | Trainer lookup had no org filter — a payout could be created against a trainer in another studio. |
| `GET /payouts` → `getTrainerPayouts()` | Trainer roll-up had no org filter — lists every studio's trainers and payout status. |
| `GET /commissions` → `getCommissionHistory()` | No org filter — commission history readable across studios. |
| `POST /commissions/calculate` → `calculateMonthlyCommissions()` | Recalculates commissions for every studio's clients on every call, not just the caller's. |

Root cause: `pt_payouts` and `pt_commissions` carry no `organization_id`
column of their own (confirmed against `011b_pt_os_module.sql`); the tenant
boundary runs through `trainer_id → pt_trainers.organization_id`
(`pt_trainers.organization_id` added in migration `143`). Every other
handler in this router that touches `pt_trainers` already scopes through
that column via the file's own `orgWhere(req, params, col)` helper and
`tenantScope(req)` (see the `/trainer-performance` and `/revenue` handlers)
— the payout/commission family was the one part of the file that had not
been brought under that pattern.

### Fix

Used the existing helpers only — no new tenant infrastructure introduced:

- `orgWhere()` / `tenantScope()` (already imported in `pt-os.routes.js`)
  for the two routes that build SQL directly (`mark-all-paid`,
  `PUT /payouts/:trainerId`).
- Added a `scope = {}` parameter (the `tenantScope(req)` shape:
  `{ isSuperAdmin, orgId, applyFilter }`) to all five service functions,
  filtered via a `trainer_id IN (SELECT id FROM pt_trainers WHERE
  organization_id = $N)` subquery where the table itself has no
  `organization_id`, or a direct `t.organization_id` / `c.organization_id`
  predicate where the query already joins a table that has one.
- `PUT /payouts/:trainerId` and `POST /payouts/:id/approve` now return
  `404` for a cross-tenant id rather than silently updating nothing —
  matching the existing "404, not 403, to avoid cross-tenant existence
  disclosure" convention used elsewhere in this file
  (`PUT /commissions/:trainerId`).
- Platform super admin operating platform-wide (no `x-org-id` target)
  remains unfiltered by design — this is `tenantScope()`'s existing,
  intentional behavior, unchanged.

### Migration

None required — no schema change. Both tables already carry the FK
(`trainer_id`) the fix scopes through.

### Test

`src/__tests__/ptOs.payouts.tenantIsolation.test.js` (new, 11 tests),
following the existing `ptOs.trainers.tenantIsolation.test.js` convention:
mocks `db/pool` and `middleware/auth`, asserts on the literal SQL and bound
params sent, not just the HTTP response (a mock can return the right rows
by accident; it can't fake the query carrying the filter).

**Result — confirmed fails before, passes after:**
- Against pre-fix code (`git stash` of the two source files, test file
  kept): **9 of 11 failed** (the 2 that passed either way are the
  "super admin platform-wide is not filtered" cases, which are correct
  under both old and new code).
- Against fixed code: **11 of 11 passed.**
- Full related suite (`ptOs*`, `pt-os*`, `*payout*`, `*commission*`):
  **65/65 passed**, 8 suites.
- Full backend suite: **2034/2093 passed**, 58 skipped (require a live DB,
  unavailable in this sandbox), **1 pre-existing unrelated failure**
  (`ai.textExtract.test.js` — native `@napi-rs/canvas`/`pdf-parse` binding
  missing in this sandbox; unrelated to tenant isolation, reproduces
  identically on unmodified `main`). **Zero regressions** attributable to
  this change.

### Security impact

Closes a cross-tenant financial-integrity gap: before the fix, any admin
account in any studio could mark another studio's trainer payouts as paid
(moving `paid_at`, `status`, and downstream commission status for money
they never touched), read another studio's commission/payout ledger, and
create or approve payouts against another studio's trainers.

### Regression risk

Low. The fix only narrows existing queries with an additional predicate
(or a subquery) already used elsewhere in the same file; it does not change
response shape, add new endpoints, or touch any table this router didn't
already query. Full non-DB-dependent test suite is green.

---

## All phases — status

The full write-up, with before / verification / fix / migration / test /
result / security impact / regression risk per finding, plus the scorecard
and the GO/NO-GO call, is in **`docs/P0_REMEDIATION_FINAL.md`**. This table
is the index.

| Phase | Status | Where |
|---|---|---|
| 0 — Safety checkpoint | Done | Above |
| 1 — Backup / recovery | **No backups existed at all** (free plan). Script added and verified end to end; **not yet scheduled anywhere** | `DISASTER-RECOVERY.md` |
| 2 — `mark-all-paid` isolation | Fixed, tested | Above · FINAL §1 |
| 3 — `leave_requests` tenancy | Fixed. Migration `168`, proven against a real database. **Not yet applied to production** | FINAL §3 |
| 4 — Super-admin credential | **Contained in the tree; rotation is outstanding and is the operator's action** | `SECURITY-INCIDENT-superadmin-credential.md` |
| 5 — Fail-closed flags | Fixed, verified by booting the server | FINAL §5 |
| 6 — RLS / BYPASSRLS | Confirmed. `app_tenant` already exists in production and is correctly configured; the cutover is an operator action | FINAL §6 |
| 7 — Commission/payout services | Fixed — the gap was the whole surface, not one route | FINAL §2 |
| 8 — `member_id` / `pt_client_id` | Fixed in 3 files, 1 latent corrected. The prompt's hypothesis was wrong for `payments.js` | FINAL §7 |
| 9 — CI/CD | Nested workflow was **inert**, not a live bypass. The real gap was `continue-on-error` on the isolation suite | FINAL §8 |
| 10 — Isolation suite | Extended 8 → 23 tests, now blocking | FINAL §9 |
| 11 — Testing gate | 2130/2131 backend · 1566/1566 frontend · 23/23 E2E | FINAL |
| 12 — Performance | M-09 done · H-11 not reproduced · H-12 and M-10 not attempted | FINAL §11 |
| 14 — Data integrity | 10 checks against production, all clean | FINAL §10 |
| 15 — Independent re-audit | No new unscoped tenant operations found | FINAL |
| 16 — Final report | Done | `P0_REMEDIATION_FINAL.md` |

**Production status: 🔴 NO-GO**, for two reasons no commit can fix: the live
super-admin credential is published in a public repository and still valid,
and six studios' data has no backup. Both are operator actions. See the top
of `P0_REMEDIATION_FINAL.md`.
