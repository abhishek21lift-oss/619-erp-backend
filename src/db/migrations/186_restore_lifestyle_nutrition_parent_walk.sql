-- Migration 186: Restore the parent-walk RLS policy on the two assessment
-- tables migration 185 silently downgraded.
--
-- ── The regression ───────────────────────────────────────────────────────
--
-- Migration 174 §5 gave pt_lifestyle_assessments and pt_nutrition_assessments
-- a two-part tenant_isolation policy on purpose:
--
--   organization_id = app.org_id
--   AND EXISTS (SELECT 1 FROM pt_clients p WHERE p.id = client_id
--               AND p.organization_id = app.org_id)
--
-- The AND matters. Both tables carry client_id, backfilled from pt_clients,
-- and their organization_id was ALSO backfilled from pt_clients at the same
-- time (174 §2) — so a caller controls the row's organization_id column
-- directly on INSERT. Without the EXISTS half, a studio can stamp its own
-- organization_id while pointing client_id at a client that belongs to a
-- DIFFERENT studio, and the write is accepted: a health/lifestyle record
-- (sleep, stress, smoking, alcohol, coach notes per 174's own header) ends up
-- attached to another studio's client, owned by the attacker's studio.
--
-- Migration 185 (this project's own WhatsApp gateway work, three migrations
-- ago) re-ran migration 157/158's generic "attach tenant_isolation to every
-- table with an organization_id column" loop, to cover the two new WhatsApp
-- tables without hand-writing a third copy of the same policy. That loop
-- does not know about the EXISTS half — it does not know these two tables
-- are child rows whose true tenant is only trustworthy via client_id, not via
-- their own organization_id column — so it DROPPED 174's two-part policy and
-- replaced it with the generic one-part version. Found by
-- rls.isolation.integration.test.js, which asserts exactly this write is
-- refused; it started failing the moment 185 (never previously on `main`)
-- landed there via this branch's merge, and reproduces deterministically
-- against a real database, not intermittently — this is not a flaky test.
--
-- pt_family_medical_history and workout_session_exercises were NOT touched by
-- 185's loop and still carry their original migration-159 policy intact —
-- neither has its own organization_id column, so the column-scan in 185's
-- loop never selected them. This migration is therefore scoped to exactly
-- the two tables actually regressed, confirmed against a live database
-- rather than assumed.
--
-- ── Why a new migration rather than editing 185 ─────────────────────────
--
-- 185 has not been applied to production — this is the first time it has
-- existed on `main` at all — so editing it in place was considered. Rejected
-- anyway: migrations in this repo are treated as an immutable, ordered log
-- (see 172's and 174's own precedent of fixing an earlier migration forward
-- rather than rewriting it), and there is no way to be certain no other
-- environment has already run 185 against a copy of this schema.
--
-- ── Warning for the next migration that touches RLS here ────────────────
--
-- If you add ANOTHER table that needs 157/158's generic loop AND that table
-- has its true tenant ownership one hop away through a foreign key (like
-- these two, or like pt_family_medical_history and workout_session_exercises
-- already do by hand) — do NOT let the generic loop cover it. Either exclude
-- it from the column scan, or give it the two-part policy explicitly, the
-- same way this migration does. The generic loop is correct only for tables
-- where organization_id is the table's own authoritative tenant column, not
-- backfilled from a child relationship a caller can still misuse.

DO $$
DECLARE
  tbl TEXT;
  fk  TEXT;
  parent TEXT;
BEGIN
  FOR tbl, fk, parent IN
    SELECT * FROM (VALUES
      ('pt_lifestyle_assessments', 'client_id', 'pt_clients'),
      ('pt_nutrition_assessments', 'client_id', 'pt_clients')
    ) AS t(tbl, fk, parent)
  LOOP
    IF to_regclass('public.' || tbl) IS NULL OR to_regclass('public.' || parent) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant '
      || 'USING ('
      || '  organization_id::text = current_setting(''app.org_id'', true) '
      || '  AND EXISTS (SELECT 1 FROM public.%I p WHERE p.id = public.%I.%I '
      || '              AND p.organization_id::text = current_setting(''app.org_id'', true))) '
      || 'WITH CHECK ('
      || '  organization_id::text = current_setting(''app.org_id'', true) '
      || '  AND EXISTS (SELECT 1 FROM public.%I p WHERE p.id = public.%I.%I '
      || '              AND p.organization_id::text = current_setting(''app.org_id'', true)))',
      tbl, parent, tbl, fk, parent, tbl, fk
    );

    RAISE NOTICE '186: % tenant_isolation restored to the two-part (column AND parent-walk) policy', tbl;
  END LOOP;
END $$;
