-- ============================================================
-- 175_cardio_performance_steps_floors.sql
-- Adds actual step/floor metrics to the already-canonical cardio performance
-- table. Existing performance rows remain unchanged and nullable.
-- ============================================================

ALTER TABLE public.cardio_performances
  ADD COLUMN IF NOT EXISTS floors_completed INTEGER,
  ADD COLUMN IF NOT EXISTS steps_completed INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cp_floors_nonneg'
       AND conrelid = 'public.cardio_performances'::regclass
  ) THEN
    ALTER TABLE public.cardio_performances
      ADD CONSTRAINT cp_floors_nonneg
      CHECK (floors_completed IS NULL OR floors_completed >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cp_steps_nonneg'
       AND conrelid = 'public.cardio_performances'::regclass
  ) THEN
    ALTER TABLE public.cardio_performances
      ADD CONSTRAINT cp_steps_nonneg
      CHECK (steps_completed IS NULL OR steps_completed >= 0);
  END IF;
END $$;
