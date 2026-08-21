-- ============================================================
-- 176_cardio_progression_notes.sql
-- Adds exercise-specific progression guidance to the cardio master records.
-- This is guidance only; planned targets remain on workout templates.
-- ============================================================

ALTER TABLE public.exercises
  ADD COLUMN IF NOT EXISTS progression_notes TEXT;

UPDATE public.exercises SET progression_notes = v.progression_notes
FROM (VALUES
  ('Bicycling', 'Progress one variable at a time: extend duration, then add small resistance or cadence changes. Add intervals only after steady work is repeatable.'),
  ('Bicycling_Stationary', 'Progress duration or total work first, then resistance or cadence. For intervals, add a round before making the work interval harder.'),
  ('Elliptical_Trainer', 'Progress steady duration before increasing resistance or incline. Keep stride quality and posture stable as intensity rises.'),
  ('Jogging_Treadmill', 'Progress duration or distance before speed. Add small speed or incline changes only when the current pace is repeatable without rail support.'),
  ('Prowler_Sprint', 'Progress distance, load, or rounds one at a time. Keep sprint posture and repeatable speed as the gate for adding load.'),
  ('Recumbent_Bike', 'Progress duration first, then resistance or cadence. Use intervals only after the continuous effort is comfortable and consistent.'),
  ('Rope_Jumping', 'Build total time through short quality intervals before increasing cadence or reducing recovery. Progress only while landings remain quiet.'),
  ('Rowing_Stationary', 'Progress distance or duration before stroke rate. Add intensity only when sequencing and posture remain consistent across every stroke.'),
  ('Running_Treadmill', 'Progress duration or distance before speed. Add incline or intervals separately and keep a controlled stride at the new demand.'),
  ('Skating', 'Progress time or distance on familiar terrain before speed. Add intervals only when stopping, turning, and balance remain reliable.'),
  ('Stairmaster', 'Progress time or floors before level. Increase level or intervals only when step rhythm and light rail contact are maintained.'),
  ('Step_Mill', 'Progress time or floors before speed. Add rounds or level gradually while keeping each step controlled and centered.'),
  ('Trail_Running_Walking', 'Progress time or distance before pace. Change terrain, elevation, or intervals one at a time and account for conditions.'),
  ('Walking_Treadmill', 'Progress duration or distance before speed. Add incline in small steps and keep the stride natural without holding the rails.')
) AS v(source_id, progression_notes)
WHERE public.exercises.source_id = v.source_id
  AND public.exercises.exercise_type = 'Cardio'
  AND public.exercises.deleted_at IS NULL;

DO $$
DECLARE updated_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO updated_count
    FROM public.exercises
   WHERE exercise_type = 'Cardio'
     AND deleted_at IS NULL
     AND progression_notes IS NOT NULL;
  -- Fresh schema-only installs may not have imported exercises yet.
  IF updated_count NOT IN (0, 14) THEN
    RAISE EXCEPTION 'Expected progression notes for 0 (fresh) or 14 cardio exercises, found %', updated_count;
  END IF;
END $$;
