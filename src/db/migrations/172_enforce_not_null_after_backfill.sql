-- ============================================================
-- 172_enforce_not_null_after_backfill.sql
-- Enforce NOT NULL on organization_id for the three tables
-- after migration 171 has backfilled the remaining NULLs.
-- 
-- This migration MUST run AFTER 171_backfill_pt_trainers_assessments_org.sql
-- because 171 backfills the remaining NULL organization_id values.
-- 
-- Migration 160 was skipped due to NULLs; this migration runs
-- AFTER 171 backfills the remaining NULLs, so it should now succeed.
-- ============================================================

DO $$
DECLARE
  t            TEXT;
  null_count   BIGINT;
  tightened    INT := 0;
  skipped      INT := 0;
  already      INT := 0;
BEGIN
  -- Tenant-owned tables whose organization_id arrived after 155 ran.
  -- These were skipped by migration 160 due to NULLs, now backfilled by 171.
  FOR t IN SELECT unnest(ARRAY['pt_trainers','pt_posture_assessments','pt_mobility_performance_assessments'])
  LOOP
    -- Not every environment has every table (the schema grew over 159+
    -- migrations and some tables arrived late), so a missing one is skipped
    -- rather than fatal — same reasoning as the to_regclass guards in 101/148.
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;

    -- Already NOT NULL: nothing to do. Keeps the migration re-runnable.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t
         AND column_name = 'organization_id' AND is_nullable = 'YES'
    ) THEN
      already := already + 1;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', t)
       INTO null_count;

    IF null_count = 0 THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', t);
      tightened := tightened + 1;
    ELSE
      skipped := skipped + 1;
      -- WARNING, not NOTICE, matching 155: psql and the deploy log surface a
      -- warning where a notice scrolls past. Never EXCEPTION — that would
      -- abort the migration run and the deploy with it, and the orphaned rows
      -- are already invisible to every studio; stopping the release does not
      -- make them visible.
      RAISE WARNING
        '172: % left nullable — % row(s) have no organization_id. They are invisible to every studio already; assign them and re-run this migration to tighten the column.',
        t, null_count;
    END IF;
  END LOOP;

  RAISE NOTICE '172: % tightened, % skipped (orphans present), % already NOT NULL.',
    tightened, skipped, already;
END $$;