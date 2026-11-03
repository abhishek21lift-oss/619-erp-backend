-- Preserve the prescription the AI wrote.
--
-- The generator emits far more than the schema could store: a separate RIR
-- target, warm-up sets, superset groups, per-exercise alternatives and cues,
-- and session-level warm-up / mobility / cool-down blocks. plan-materialise
-- mapped only the subset with columns, so the trainer saved a programme that
-- had quietly lost the detail the model was asked to produce.
--
-- Additive only. `rpe` keeps its existing meaning (RPE 1-10, with RIR inverted
-- onto that scale for callers that only read one number); `rir` is the
-- original scale the coach wrote, stored beside it rather than replacing it.
-- JSONB is deliberate: alternatives are {name, reason} objects and protocol
-- blocks vary by studio, so a rigid column set would be wrong for both.

ALTER TABLE workout_exercises
  ADD COLUMN IF NOT EXISTS rir          NUMERIC(3,1),
  ADD COLUMN IF NOT EXISTS alternatives JSONB,
  ADD COLUMN IF NOT EXISTS cues         JSONB;

ALTER TABLE workout_plans
  ADD COLUMN IF NOT EXISTS warmup_protocol   JSONB,
  ADD COLUMN IF NOT EXISTS mobility_protocol JSONB,
  ADD COLUMN IF NOT EXISTS cooldown_protocol JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'workout_exercises_rir_range'
       AND conrelid = 'public.workout_exercises'::regclass
  ) THEN
    ALTER TABLE public.workout_exercises
      ADD CONSTRAINT workout_exercises_rir_range
      CHECK (rir IS NULL OR (rir >= 0 AND rir <= 10));
  END IF;
END $$;

COMMENT ON COLUMN public.workout_exercises.rir          IS 'Reps in reserve as written by the coach; rpe stays the 1-10 equivalent.';
COMMENT ON COLUMN public.workout_exercises.alternatives IS 'Swaps for this movement: [{name, reason}] or plain names.';
COMMENT ON COLUMN public.workout_exercises.cues         IS 'Coaching cues for this movement, as written.';
COMMENT ON COLUMN public.workout_plans.warmup_protocol   IS 'Session warm-up block: string[] or a structured object.';
COMMENT ON COLUMN public.workout_plans.mobility_protocol IS 'Mobility work, typically performed before or between sessions.';
COMMENT ON COLUMN public.workout_plans.cooldown_protocol IS 'Session cool-down block: string[] or a structured object.';
