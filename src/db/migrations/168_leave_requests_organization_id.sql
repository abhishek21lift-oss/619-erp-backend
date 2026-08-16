-- ============================================================
-- 168_leave_requests_organization_id.sql
--
-- `leave_requests` has carried no organization_id since it was created in
-- 001_v4_upgrade.sql, so /api/leave could not be tenant-scoped even in
-- principle — there was nothing on the row to scope by. All four handlers in
-- src/routes/leave.js (list, get by id, approve, reject) filtered by status,
-- trainer and date and by nothing else, behind `auth` and — for the two
-- writes — `adminOrManager`.
--
-- adminOrManager is a ROLE gate, not a tenant gate: it answers "may this
-- person approve leave", never "whose leave". So an admin or manager in any
-- studio could list every studio's leave requests (the payload carries
-- trainer name, email and mobile via the LEFT JOIN on trainers), read any one
-- by id, and approve or reject another studio's trainer's leave by id. The
-- two writes are the sharp end: approving somebody else's staffing decision
-- is not a read leak, it is a write into another business's roster.
--
-- This is the same class as migration 143 (pt_trainers) one table over, and
-- it is fixed the same way: give the row an owner, then scope the routes.
--
-- ── Why the column, and not a join through trainers ─────────────────────
--
-- leave_requests.trainer_id already REFERENCES trainers(id), and `trainers`
-- has carried organization_id since 078, so every handler could in principle
-- reach the tenant through a join. The column is added anyway, for the same
-- two reasons 143 gives:
--
--   1. A join-based filter is one forgotten JOIN away from being no filter.
--      A column is checkable by the standing convention test
--      (tenantScope.convention.test.js derives its tenant-table list from
--      these migration files) and by migration 157's RLS policy scan.
--   2. Database-level RLS needs the column. 157 builds one policy per table
--      carrying organization_id; a table without one gets no policy, and
--      once DATABASE_URL is cut over to app_tenant a policy-less table with
--      RLS enabled returns zero rows silently. That is the failure mode
--      migration 159 was written to catch — see its header.
--
-- ── Backfilling ─────────────────────────────────────────────────────────
--
-- One pass: the trainer the request belongs to. leave_requests.trainer_id is
-- NOT NULL and FK-enforced against trainers(id), so every row has exactly one
-- trainer and that trainer's studio is the request's studio. There is no
-- ambiguity to resolve and so no second pass of the kind 143 needed.
--
-- Verified against production before writing this: leave_requests holds 0
-- rows, 0 rows with a dangling trainer_id, and 0 active trainers with a NULL
-- organization_id — so the backfill is a no-op today and the NOT NULL below
-- will be taken rather than skipped. The backfill is written properly anyway,
-- because this migration also runs against staging, local databases and any
-- restored snapshot, where none of those three counts are guaranteed.
-- ============================================================

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

-- Matches the FK-index convention of 135; every tenant-scoped read of this
-- table filters on this column, and the approve/reject writes look up by
-- (id, organization_id).
CREATE INDEX IF NOT EXISTS idx_leave_requests_organization_id
  ON leave_requests(organization_id);

-- The owning studio is the studio of the trainer the leave is for.
UPDATE leave_requests lr
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE t.id = lr.trainer_id
   AND lr.organization_id IS NULL
   AND t.organization_id IS NOT NULL;

-- ── Tighten to NOT NULL, but only if that is safe ───────────────────────
--
-- Same shape and same reasoning as migrations 155 and 160: migrate.js aborts
-- the whole run on the first failure and the deploy applies migrations before
-- the new container serves traffic, so a bare SET NOT NULL against a table
-- holding one unattributable row would take the deploy down. A data-quality
-- problem should not become an outage — least of all on a change whose point
-- is to make data quality visible.
--
-- Re-runnable: a row that could not be attributed today can be assigned by
-- hand and this migration re-run to tighten the column.
DO $$
DECLARE
  null_count BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'leave_requests'
       AND column_name = 'organization_id' AND is_nullable = 'YES'
  ) THEN
    SELECT count(*) INTO null_count
      FROM leave_requests WHERE organization_id IS NULL;

    IF null_count = 0 THEN
      ALTER TABLE leave_requests ALTER COLUMN organization_id SET NOT NULL;
      RAISE NOTICE '168: leave_requests.organization_id tightened to NOT NULL.';
    ELSE
      -- WARNING not EXCEPTION, matching 155/160: these rows are already
      -- invisible to every studio once the routes filter, and aborting the
      -- release does not make them visible.
      RAISE WARNING
        '168: leave_requests.organization_id left nullable — % row(s) have no organization_id (their trainer has none either). Assign them and re-run this migration to tighten the column.',
        null_count;
    END IF;
  END IF;
END $$;

-- ── RLS policy ──────────────────────────────────────────────────────────
--
-- Migration 157 discovers its policy list by scanning for organization_id at
-- the time it runs, so a column added afterwards gets no policy — 157 has
-- already run everywhere. Without this block, leave_requests would be a table
-- with RLS enabled (the convention since 104, tightened wholesale by 131) and
-- no app_tenant policy, which does not raise: it returns zero rows. Leave
-- would go quiet on the day DATABASE_URL is cut over to app_tenant, with no
-- error and nothing to page on. That is exactly the gap migration 159 was
-- written to close for eleven other tables, so this follows 159's lead and
-- closes it in the same migration that opens it.
--
-- Strict shape (not the shared one): leave belongs to a studio, never to the
-- platform, so there is no legitimate NULL-organization row to admit. Granted
-- ONLY to app_tenant — never public/anon/authenticated, per the GUC caution
-- in TENANT-RLS-PLAN.md — and the existing deny-all policies for those roles
-- are left untouched.
--
-- Inert until the app_tenant cutover, like everything else 157 added: the API
-- connects as the table owner today, and RLS does not apply to a table's
-- owner.
DO $$
BEGIN
  IF to_regclass('public.leave_requests') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE 'ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.leave_requests';
    EXECUTE
      'CREATE POLICY tenant_isolation ON public.leave_requests FOR ALL TO app_tenant ' ||
      'USING (organization_id::text = current_setting(''app.org_id'', true)) ' ||
      'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))';
  END IF;
END $$;
