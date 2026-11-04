-- ─────────────────────────────────────────────────────────────────────────
-- 264 — The Client Interview, as selections rather than typing
-- ─────────────────────────────────────────────────────────────────────────
--
-- The interview screen was rebuilt around the Training Availability card:
-- searchable occupation, single-select work/experience cards, duration
-- dropdowns, multi-select chips, segmented answers and a 1–10 readiness
-- scale. This migration adds the columns those controls write.
--
-- Nothing existing is renamed, dropped or rewritten. The older free-text
-- columns (job_details, training_history, preferences, motivation,
-- important_client_statements) stay readable and writable, so an interview
-- recorded before this change keeps every word and can still be corrected.
--
-- All columns are nullable: a skipped answer is NULL, never a guessed value.
-- The service validates every enum and every array key first and returns a
-- 400; the CHECKs below are the database's backstop.
--
-- Additive and idempotent. No column or row is dropped or rewritten.
-- No BEGIN/COMMIT — migrate.js wraps this with the _migrations record.

ALTER TABLE pt_client_interviews
  ADD COLUMN IF NOT EXISTS occupation_title TEXT
    CHECK (occupation_title IS NULL OR char_length(occupation_title) <= 120),
  ADD COLUMN IF NOT EXISTS work_type TEXT,
  ADD COLUMN IF NOT EXISTS work_hours_band TEXT,
  ADD COLUMN IF NOT EXISTS daily_activity_level TEXT,
  ADD COLUMN IF NOT EXISTS training_duration TEXT,
  ADD COLUMN IF NOT EXISTS sports_played TEXT[],
  ADD COLUMN IF NOT EXISTS previous_activities TEXT[],
  ADD COLUMN IF NOT EXISTS exercise_preferences TEXT[],
  ADD COLUMN IF NOT EXISTS fitness_goals TEXT[],
  ADD COLUMN IF NOT EXISTS motivation_factors TEXT[],
  ADD COLUMN IF NOT EXISTS client_attitude TEXT,
  ADD COLUMN IF NOT EXISTS confidence_level TEXT,
  ADD COLUMN IF NOT EXISTS commitment_level TEXT,
  ADD COLUMN IF NOT EXISTS coaching_preference TEXT,
  ADD COLUMN IF NOT EXISTS initial_training_level TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_work_type_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_work_type_check
      CHECK (work_type IS NULL OR work_type IN (
        'desk', 'on_feet', 'physical', 'mixed', 'shifts', 'field', 'other'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_work_hours_band_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_work_hours_band_check
      CHECK (work_hours_band IS NULL OR work_hours_band IN (
        'under_4', '4_6', '6_8', '8_10', '10_plus', 'varies'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_daily_activity_level_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_daily_activity_level_check
      CHECK (daily_activity_level IS NULL OR daily_activity_level IN (
        'mostly_seated', 'light', 'moderately_active', 'very_active'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_training_duration_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_training_duration_check
      CHECK (training_duration IS NULL OR training_duration IN (
        'none', 'under_3_months', '3_6_months', '6_12_months', '1_2_years', '2_plus_years'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_client_attitude_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_client_attitude_check
      CHECK (client_attitude IS NULL OR client_attitude IN (
        'motivated', 'neutral', 'anxious', 'resistant'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_confidence_level_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_confidence_level_check
      CHECK (confidence_level IS NULL OR confidence_level IN ('low', 'medium', 'high'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_commitment_level_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_commitment_level_check
      CHECK (commitment_level IS NULL OR commitment_level IN ('low', 'moderate', 'high'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_coaching_preference_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_coaching_preference_check
      CHECK (coaching_preference IS NULL OR coaching_preference IN ('strict', 'supportive', 'balanced'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_initial_training_level_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_initial_training_level_check
      CHECK (initial_training_level IS NULL OR initial_training_level IN ('beginner', 'intermediate', 'advanced'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_sports_played_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_sports_played_check
      CHECK (
        sports_played IS NULL OR sports_played <@ ARRAY[
          'cricket', 'football', 'badminton', 'tennis', 'table_tennis',
          'basketball', 'volleyball', 'hockey', 'athletics', 'swimming',
          'cycling', 'running', 'boxing', 'martial_arts', 'gymnastics',
          'rowing', 'golf', 'squash', 'dance', 'other'
        ]::text[]
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_previous_activities_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_previous_activities_check
      CHECK (
        previous_activities IS NULL OR previous_activities <@ ARRAY[
          'walking', 'running', 'cycling', 'swimming', 'gym_weights',
          'cardio_machines', 'home_workouts', 'yoga', 'pilates',
          'martial_arts', 'dance', 'sports', 'physical_job', 'none'
        ]::text[]
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_exercise_preferences_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_exercise_preferences_check
      CHECK (
        exercise_preferences IS NULL OR exercise_preferences <@ ARRAY[
          'free_weights', 'machines', 'bodyweight', 'cardio', 'hiit',
          'yoga', 'pilates', 'stretching', 'outdoors', 'group_classes',
          'home_workouts', 'sports', 'no_preference'
        ]::text[]
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_fitness_goals_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_fitness_goals_check
      CHECK (
        fitness_goals IS NULL OR fitness_goals <@ ARRAY[
          'fat_loss', 'muscle_gain', 'body_recomposition', 'strength_gain',
          'endurance', 'general_fitness', 'mobility', 'athletic_performance',
          'medical_fitness', 'wedding_transformation', 'senior_fitness'
        ]::text[]
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_motivation_factors_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_motivation_factors_check
      CHECK (
        motivation_factors IS NULL OR motivation_factors <@ ARRAY[
          'health', 'appearance', 'energy', 'confidence', 'strength',
          'event', 'doctor_advice', 'family', 'accountability', 'stress',
          'sport', 'habit'
        ]::text[]
      );
  END IF;
END $$;

COMMENT ON COLUMN pt_client_interviews.occupation_title IS
  'The occupation the trainer picked from the predefined list. occupation_type keeps the canonical scoring category.';
COMMENT ON COLUMN pt_client_interviews.work_type IS
  'How the client works: desk/on_feet/physical/mixed/shifts/field/other. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.work_hours_band IS
  'Typical working hours per day, as a band. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.daily_activity_level IS
  'Typical daily activity outside training: mostly_seated/light/moderately_active/very_active. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.training_duration IS
  'How long the client has trained, as a band. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.sports_played IS
  'Canonical sport keys. Client-stated; NULL means not asked.';
COMMENT ON COLUMN pt_client_interviews.previous_activities IS
  'Canonical physical-activity keys the client has done before. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.exercise_preferences IS
  'Canonical exercise-style keys the client prefers. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.fitness_goals IS
  'Goal keys the client named in the interview. The dated goal record remains pt_goals. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.motivation_factors IS
  'Canonical reasons that motivate the client. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.client_attitude IS
  'The trainer''s read of the client''s attitude: motivated/neutral/anxious/resistant. Trainer-written.';
COMMENT ON COLUMN pt_client_interviews.confidence_level IS
  'The trainer''s read of the client''s confidence: low/medium/high. Trainer-written.';
COMMENT ON COLUMN pt_client_interviews.commitment_level IS
  'The trainer''s read of the client''s commitment: low/moderate/high. Trainer-written.';
COMMENT ON COLUMN pt_client_interviews.coaching_preference IS
  'How the client wants to be coached: strict/supportive/balanced. Trainer-written.';
COMMENT ON COLUMN pt_client_interviews.initial_training_level IS
  'The trainer''s starting level for this client. pt_clients.workout_experience_level remains the live programme level.';
