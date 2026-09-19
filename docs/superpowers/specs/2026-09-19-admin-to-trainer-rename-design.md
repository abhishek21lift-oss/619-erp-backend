# Admin → Trainer hard rename — design

**Date:** 2026-09-19
**Status:** approved (full 5-section design, chat 2026-09-19)
**Scope:** `619-erp-backend` + `619-erp-frontend`
**Approach:** A. Hard rename — `admin` identifier deleted everywhere, `trainer` becomes the single studio-owner role.

## 1. Semantics & scope

- `trainer` = the single studio-owner role: full tenant powers (payouts, commissions, branches, settings, reports) and full data visibility (all clients, all revenue — today's `admin` behavior).
- Old assistant-coach `trainer` (sees only assigned clients via `requireTrainerOwnership`, `pt-os.service.js:510`) is merged into owner and ceases to exist. Any account that today sees only its own clients will see everything after this change. Accepted by owner.
- Untouched: `super_admin` (platform operator), `member` (client), `manager`/`staff`/`reception` (kept, zero accounts, no behavior change). `/api/admin/*` mounts are platform-operator routes behind `PLATFORM_GUARD` — untouched.
- Display: `ROLE_LABELS.trainer` becomes `'Trainer'` (today `'Assistant Coach'`); the `admin`→`'Trainer'` label hack is deleted with the identifier.

## 2. Backend

- New migration (next free number after checking 174/175/176 dupes, 185/194/199):
  1. Abort if any `users` row with `role='admin'` has NULL `organization_id` (violates migration 175 invariant).
  2. Backup renamed rows (`id`, `role`) into `_backup_admin_rename`.
  3. `UPDATE users SET role='trainer' WHERE role='admin'`; bump `token_version` for those rows (kills stale `admin`-claim JWTs + refresh tokens, forces fresh login).
  4. Drop `users_role_check`, re-add without `'admin'` (keep `super_admin, manager, trainer, reception, member` + `staff` iff present in the live constraint — read it first, don't assume migration 078 is current).
  5. Fix migration 101's `WITH CHECK (app.role='admin')` policy to `'trainer'`.
  6. Idempotent re-run safe; verified on throwaway PG (same pattern as migration 168).
- `middleware/auth.js`: `adminOnly`→`trainerOnly`, `adminOrManager`→`trainerOrManager`. No alias exports.
- `middleware/rbac.js`: `STAFF_ROLES` drops `'admin'`; `requireTrainerOwnership` admin-bypass deleted (trainer passes as owner); `requireRole('admin',…)` → `requireRole('trainer',…)` repo-wide (~40 sites: payouts, commissions, reports, trainers CRUD, PAR-Q, progress, workout-log, leads, assessments).
- `routes/auth.js:664` `ALLOWED_ROLES`, `lib/validation.js:63` zod enum, `lib/ai/tools.js` roles arrays, `modules/training/authz.js` updated.
- Tests: `role:'admin'` mocks → `'trainer'`; `adminOnly` mock names → `trainerOnly`; convention tests (`tenantScope`, `rls`, `staffOnlyRouters`) updated; 23-test isolation suite re-run as `trainer`.

## 3. Frontend

- `lib/roles.ts`: `Role` drops `'admin'`; `hasRole` workspace-superuser branch moves `admin`→`trainer` (trainer passes any non-`super_admin` gate); `ROLE_LABELS` drops `admin`, `trainer`→`'Trainer'`; `ASSIGNABLE_ROLES=['trainer']`.
- Codemod `role="admin"`→`role="trainer"`, `['admin',…]`→`['trainer',…]` (~50 Guards, `nav-config.ts`, `module-config.ts`, `permissions-context.tsx`, `Sidebar.tsx`); `nav-config.ts:376` super_admin effective role `'admin'`→`'trainer'`.
- Portals/login: `/login` admits `trainer` not `admin`; `postSignInPath` trainer→`/trainer/dashboard` unchanged (becomes the staff home).
- `/admin/*` web routes removed: `(chrome)/admin/biometrics` → `/settings/biometrics`; `/admin` + `/admin/dashboard` redirects repointed (today →`/` in `next.config.js:80-81`). No `/admin` URL remains.
- `roleLabel` / `sign-in-return-to` / `auth-context` tests updated.

## 4. Migration safety & rollout

- Pre-checks: row counts, orphan-`admin` abort, live CHECK-constraint read.
- Forward-only migration with backup table; rollback = restore runbook from `_backup_admin_rename`, not auto-rollback.
- Deploy order: merge → `npm run migrate` (existing pipeline pattern) → restart backend → deploy frontend. Mixed-version window fails closed (403) for stale `admin`-claim JWTs; 15-min access TTL + `token_version` bump bounds it to one forced re-login. Announce it.

## 5. Verification

- Backend jest (2130) + RLS isolation integration (23) + E2E cross-tenant as `trainer` + new migration test (clean apply, idempotent, `admin` INSERT rejected, renamed user passes `trainerOnly`, ex-`admin` JWT 403s). All green before merge.
- Frontend vitest (1566) + `route-groups` + `roles` tests; manual pass: owner login, payouts, trainer CRUD, PAR-Q, member isolation intact.
- Post-merge grep: no `'admin'` string remains in either `src/` except explicitly-marked historical comments.

## Residuals / non-goals

- `manager`/`staff`/`reception` dead roles are NOT deleted (separate cleanup if ever wanted).
- Git history still contains `admin` references; no history rewrite (same reasoning as the super-admin hash incident: rotation/migration forward, don't rewrite).
- `/api/admin/*` platform naming confusion documented, not renamed.
