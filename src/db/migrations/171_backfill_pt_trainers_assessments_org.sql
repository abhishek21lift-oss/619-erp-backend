-- ============================================================
-- 171_backfill_pt_trainers_assessments_org.sql
-- Backfill organization_id for the three tables that migration 160
-- could not tighten because they had NULL rows.
--
-- This migration derives organization_id from authoritative relationships:
--   pt_trainers         -> via pt_clients they train (unambiguous studio)
--   pt_posture_assessments      -> via pt_clients.client_id
--   pt_mobility_performance_assessments -> via pt_clients.client_id
--
-- Run BEFORE migration 160 re-attempt.
-- ============================================================

-- ============================================================
-- pt_trainers ────────────────────────────────────────────────
-- Backfill from pt_clients they train (unambiguous studio only)
-- ============================================================
UPDATE pt_trainers pt
   SET organization_id = sole.organization_id
  FROM (
    SELECT trainer_id, (array_agg(DISTINCT organization_id))[1] AS organization_id
      FROM pt_clients
     WHERE trainer_id IS NOT NULL
       AND organization_id IS NOT NULL
       AND deleted_at IS NULL
     GROUP BY trainer_id
    HAVING COUNT(DISTINCT organization_id) = 1
  ) sole
 WHERE sole.trainer_id = pt.id
   AND pt.organization_id IS NULL
   AND pt.deleted_at IS NULL;

-- Also backfill `trainers` table (same pattern as migration 143)
UPDATE trainers t
   SET organization_id = sole.organization_id
  FROM (
    SELECT trainer_id, (array_agg(DISTINCT organization_id))[1] AS organization_id
      FROM pt_clients
     WHERE trainer_id IS NOT NULL
       AND organization_id IS NOT NULL
       AND deleted_at IS NULL
     GROUP BY trainer_id
    HAVING COUNT(DISTINCT organization_id) = 1
  ) sole
 WHERE sole.trainer_id = t.id
   AND t.organization_id IS NULL
   AND t.deleted_at IS NULL;

-- ============================================================
-- pt_posture_assessments ─────────────────────────────────────
-- Backfill from pt_clients.client_id (direct FK)
-- ============================================================
UPDATE pt_posture_assessments p
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = p.client_id
   AND p.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

-- ============================================================
-- pt_mobility_performance_assessments ────────────────────────
-- Backfill from pt_clients.client_id (direct FK)
-- ============================================================
UPDATE pt_mobility_performance_assessments m
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = m.client_id
   AND m.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

-- ============================================================
-- Fallback for single-org deployments (same as 156)
-- Only runs if exactly one organization exists
-- ============================================================
UPDATE pt_trainers
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND deleted_at IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

UPDATE pt_posture_assessments
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

UPDATE pt_mobility_performance_assessments
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- ============================================================
-- Report remaining NULLs (same pattern as 143/160)
-- ============================================================
DO $$
DECLARE
  null_trainers  INT;
  null_posture   INT;
  null_mobility  INT;
BEGIN
  SELECT count(*) INTO null_trainers FROM pt_trainers
   WHERE organization_id IS NULL AND deleted_at IS NULL AND status = 'active';
  SELECT count(*) INTO null_posture FROM pt_posture_assessments
   WHERE organization_id IS NULL;
  SELECT count(*) INTO null_mobility FROM pt_mobility_performance_assessments
   WHERE organization_id IS NULL;

  IF null_trainers > 0 OR null_posture > 0 OR null_mobility > 0 THEN
    RAISE NOTICE '171: pt_trainers: % active row(s), pt_posture_assessments: % row(s), pt_mobility_performance_assessments: % row(s) still have no organization_id. They are now hidden from every studio rather than shown to all of them — assign them to a studio to restore them.',
      null_trainers, null_posture, null_mobility;
  END IF;
END $$;
