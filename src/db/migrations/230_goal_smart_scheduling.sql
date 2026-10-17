-- ============================================================
-- 230_goal_smart_scheduling.sql
-- Extends pt_goals with SMART goal scheduling/routine fields:
--   - status: active | paused | completed | archived
--   - training_days_per_week, preferred_training_days
--   - training_split (recommended/selected split)
--   - routine_blueprint (JSONB) — sets/reps/RPE/rest/tempo blueprint
--   - milestones (JSONB array)
--   - review_date, short/medium/long-term horizon weeks
-- Backward compatible: is_active is kept in sync with status.
-- ============================================================
DO $$ BEGIN
  ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','completed','archived'));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals status: %', SQLERRM; END $$;

DO $$ BEGIN
  ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS training_days_per_week SMALLINT;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals training_days_per_week: %', SQLERRM; END $$;

DO $$ BEGIN
  ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS preferred_training_days TEXT[];
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals preferred_training_days: %', SQLERRM; END $$;

DO $$ BEGIN
  ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS training_split TEXT;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals training_split: %', SQLERRM; END $$;

DO $$ BEGIN
  ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS routine_blueprint JSONB;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals routine_blueprint: %', SQLERRM; END $$;

DO $$ BEGIN
  ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS milestones JSONB;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals milestones: %', SQLERRM; END $$;

DO $$ BEGIN
  ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS review_date DATE;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals review_date: %', SQLERRM; END $$;

DO $$ BEGIN
  ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS short_term_weeks SMALLINT DEFAULT 8;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals short_term_weeks: %', SQLERRM; END $$;

DO $$ BEGIN
  ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS medium_term_weeks SMALLINT DEFAULT 12;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals medium_term_weeks: %', SQLERRM; END $$;

-- Backfill status from is_active
UPDATE pt_goals SET status = CASE WHEN is_active THEN 'active' ELSE 'archived' END
  WHERE status IS NULL OR status = '';

CREATE INDEX IF NOT EXISTS pg_status_idx ON pt_goals (client_id, status);
