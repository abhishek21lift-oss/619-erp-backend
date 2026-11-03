-- 260_powerlifting_periodization.sql
--
-- Powerlifting is a block, not a strength-flavoured workout. The generic
-- prescription columns can say "5 × 5 at RPE 7" but they cannot say "week 4 of
-- a 12-week block is the Base deload, and every main lift is 65% of a
-- training max that is itself 90% of the best logged e1RM".
--
-- ── What is stored where ───────────────────────────────────────────────────
--
--   workout_training_maxes   the trainer's number for one lift, one client.
--                            One current row per (client, exercise): the
--                            percentage in a block is only meaningful if
--                            there is exactly one max behind it.
--
--   workout_plans.periodization_model
--                            NULL for every plan written before this
--                            migration. 'powerlifting_block' marks a plan
--                            whose weeks were generated from the block
--                            engine; 'linear' is the existing rule.
--
--   workout_plans.block_phases
--                            JSONB array of {week, phase, label, is_deload}.
--                            The rows in workout_exercises already carry the
--                            prescription for each week; this carries the
--                            label a client and trainer read beside it, so a
--                            deload week is visibly a deload rather than just
--                            a lighter one.
--
--   workout_plans.deload_every_weeks / deload_intensity_pct
--                            Opt-in deloads for ordinary linear plans. NULL
--                            means "no automatic deload", which is every
--                            existing plan and preserves its behaviour.
--
-- ── Why e1RM is not stored here ────────────────────────────────────────────
--
-- e1RM is derived from workout_sets by training-history.js, the same way it
-- already is for the analytics screen. A second stored copy would be a second
-- answer to "what is this client's best bench" that can disagree with the
-- sets it came from.
--
-- Additive only; no column is dropped, no row is rewritten. Idempotent.

CREATE TABLE IF NOT EXISTS workout_training_maxes (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id        TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  exercise_id      TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  training_max_kg  NUMERIC(6,2) NOT NULL
                     CHECK (training_max_kg > 0 AND training_max_kg < 1000),
  -- The evidence the max was set from, kept beside it so a later review can
  -- tell a number the trainer typed from one the engine suggested.
  source_e1rm_kg   NUMERIC(6,2)
                     CHECK (source_e1rm_kg IS NULL OR source_e1rm_kg > 0),
  source           TEXT NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual', 'e1rm_suggestion', 'import')),
  notes            TEXT,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, exercise_id)
);

CREATE INDEX IF NOT EXISTS workout_training_maxes_client
  ON workout_training_maxes (organization_id, client_id);

ALTER TABLE workout_training_maxes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workout_training_maxes FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON workout_training_maxes;
CREATE POLICY deny_all_direct_access ON workout_training_maxes
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON workout_training_maxes;
CREATE POLICY tenant_isolation ON workout_training_maxes FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON workout_training_maxes TO app_tenant;

COMMENT ON TABLE workout_training_maxes IS
  'The trainer-controlled training max behind a powerlifting percentage block (migration 260).';
COMMENT ON COLUMN workout_training_maxes.training_max_kg IS
  'A load the trainer owns, deliberately below a true 1RM. Never auto-raised.';
COMMENT ON COLUMN workout_training_maxes.source_e1rm_kg IS
  'Best logged e1RM at the time the max was set, or NULL when typed without one.';

ALTER TABLE workout_plans
  ADD COLUMN IF NOT EXISTS periodization_model TEXT,
  ADD COLUMN IF NOT EXISTS split_name          TEXT,
  ADD COLUMN IF NOT EXISTS block_phases        JSONB,
  ADD COLUMN IF NOT EXISTS deload_every_weeks  INTEGER,
  ADD COLUMN IF NOT EXISTS deload_intensity_pct NUMERIC(5,2);

ALTER TABLE workout_plans DROP CONSTRAINT IF EXISTS workout_plans_periodization_model_check;
ALTER TABLE workout_plans
  ADD CONSTRAINT workout_plans_periodization_model_check
  CHECK (periodization_model IS NULL OR periodization_model IN ('linear', 'powerlifting_block'));

ALTER TABLE workout_plans DROP CONSTRAINT IF EXISTS workout_plans_deload_every_weeks_check;
ALTER TABLE workout_plans
  ADD CONSTRAINT workout_plans_deload_every_weeks_check
  CHECK (deload_every_weeks IS NULL OR deload_every_weeks BETWEEN 2 AND 12);

ALTER TABLE workout_plans DROP CONSTRAINT IF EXISTS workout_plans_deload_intensity_pct_check;
ALTER TABLE workout_plans
  ADD CONSTRAINT workout_plans_deload_intensity_pct_check
  CHECK (deload_intensity_pct IS NULL OR deload_intensity_pct BETWEEN 30 AND 100);

-- The progression rule now has a block mode. Existing rows keep 'none' or
-- their linear rule; the CHECK is widened, never narrowed.
ALTER TABLE workout_plans DROP CONSTRAINT IF EXISTS workout_plans_progression_type_check;
ALTER TABLE workout_plans
  ADD CONSTRAINT workout_plans_progression_type_check
  CHECK (progression_type IN ('none', 'weight', 'reps', 'rpe', 'block'));

COMMENT ON COLUMN workout_plans.periodization_model IS
  'NULL for legacy/linear plans; powerlifting_block when weeks came from the block engine.';
COMMENT ON COLUMN workout_plans.block_phases IS
  'Week labels for a block: [{week, phase, label, is_deload}]. The rows carry the prescription.';
COMMENT ON COLUMN workout_plans.deload_every_weeks IS
  'Opt-in linear-plan deload cadence. NULL means no automatic deload.';
