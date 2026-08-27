-- ============================================================
-- 179_workout_sets_cardio_fields.sql
--
-- Cardio logging on the legacy Workout Log. Mirrors the Training OS
-- cardio_performances column vocabulary (migrations 165/175) so both
-- loggers speak the same contract. All columns are nullable; existing
-- rows are untouched and strength sets keep using weight_kg/reps,
-- leaving every cardio column NULL.
--
-- Speed is stored with its unit rather than derived from distance/time:
-- machines report an average speed directly, and a lossy conversion on
-- write cannot be undone on read.
-- ============================================================

ALTER TABLE public.workout_sets
  ADD COLUMN IF NOT EXISTS duration_seconds   INTEGER,
  ADD COLUMN IF NOT EXISTS distance           NUMERIC(9,3),
  ADD COLUMN IF NOT EXISTS distance_unit      TEXT,
  ADD COLUMN IF NOT EXISTS average_speed      NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS speed_unit         TEXT,
  ADD COLUMN IF NOT EXISTS calories_burned    INTEGER,
  ADD COLUMN IF NOT EXISTS average_heart_rate SMALLINT,
  ADD COLUMN IF NOT EXISTS cadence            SMALLINT,
  ADD COLUMN IF NOT EXISTS steps_completed    INTEGER,
  ADD COLUMN IF NOT EXISTS floors_completed   INTEGER,
  ADD COLUMN IF NOT EXISTS rounds_completed   SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ws_distance_unit_check'
       AND conrelid = 'public.workout_sets'::regclass
  ) THEN
    ALTER TABLE public.workout_sets ADD CONSTRAINT ws_distance_unit_check
      CHECK (distance_unit IS NULL OR distance_unit IN ('m', 'km', 'mile'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ws_speed_unit_check'
       AND conrelid = 'public.workout_sets'::regclass
  ) THEN
    ALTER TABLE public.workout_sets ADD CONSTRAINT ws_speed_unit_check
      CHECK (speed_unit IS NULL OR speed_unit IN ('kmh', 'mph'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ws_heart_rate_check'
       AND conrelid = 'public.workout_sets'::regclass
  ) THEN
    ALTER TABLE public.workout_sets ADD CONSTRAINT ws_heart_rate_check
      CHECK (average_heart_rate IS NULL OR average_heart_rate BETWEEN 20 AND 250);
  END IF;

  -- A distance with no unit is a number nobody can read back.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ws_distance_needs_unit'
       AND conrelid = 'public.workout_sets'::regclass
  ) THEN
    ALTER TABLE public.workout_sets ADD CONSTRAINT ws_distance_needs_unit
      CHECK (distance IS NULL OR distance_unit IS NOT NULL);
  END IF;
END $$;

COMMENT ON COLUMN public.workout_sets.duration_seconds IS
  'Cardio actuals — how long this set/effort took. NULL for strength sets.';
COMMENT ON COLUMN public.workout_sets.distance IS
  'Cardio actuals — distance covered, in distance_unit.';
COMMENT ON COLUMN public.workout_sets.average_speed IS
  'Cardio actuals — average speed, in speed_unit.';
COMMENT ON COLUMN public.workout_sets.cadence IS
  'Cardio actuals — average cadence/RPM for cadence-based modalities.';
COMMENT ON COLUMN public.workout_sets.steps_completed IS
  'Cardio actuals — steps for step-based modalities (mirrors cardio_performances).';
COMMENT ON COLUMN public.workout_sets.floors_completed IS
  'Cardio actuals — floors for stair-climbing modalities (mirrors cardio_performances).';
