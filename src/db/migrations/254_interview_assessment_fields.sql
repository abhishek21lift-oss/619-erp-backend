-- ─────────────────────────────────────────────────────────────────────────
-- 254 — The Client Interview's conversation fields
-- ─────────────────────────────────────────────────────────────────────────
--
-- Migration 227 wrote the interview as seven free-text answers and 228a added
-- eight structured lifestyle columns, but the screen only ever asked three
-- selects. This adds the fields the redesigned interview actually asks:
--
--   work detail          job_details, occupation_other_details
--   training background  previous_workout_experience
--   training challenges  training_challenges (multi-select) + challenge_other
--   the client's words   important_client_statements
--
-- Occupation type, screen time and activity level stay where the target
-- architecture put them — the Lifestyle Assessment. The Interview reads them
-- and does not write a second copy. The legacy lifestyle_* columns here stay
-- readable and writable for callers written before that decision; the UI no
-- longer offers them.
--
-- All columns are nullable and additive. Existing rows are untouched and a
-- completed interview keeps its status and completed_at.
--
-- Idempotent; safe to re-run. No BEGIN/COMMIT — migrate.js wraps this with the
-- _migrations insert.

ALTER TABLE pt_client_interviews
  ADD COLUMN IF NOT EXISTS job_details TEXT
    CHECK (job_details IS NULL OR char_length(job_details) <= 2000),
  ADD COLUMN IF NOT EXISTS occupation_other_details TEXT
    CHECK (occupation_other_details IS NULL OR char_length(occupation_other_details) <= 500),
  ADD COLUMN IF NOT EXISTS previous_workout_experience TEXT
    CHECK (previous_workout_experience IS NULL OR previous_workout_experience IN ('never', 'beginner', 'intermediate', 'advanced')),
  ADD COLUMN IF NOT EXISTS training_challenges TEXT[],
  ADD COLUMN IF NOT EXISTS challenge_other TEXT
    CHECK (challenge_other IS NULL OR char_length(challenge_other) <= 500),
  ADD COLUMN IF NOT EXISTS important_client_statements TEXT
    CHECK (important_client_statements IS NULL OR char_length(important_client_statements) <= 2000);

-- The challenge list is a fixed vocabulary, so a caller cannot smuggle free
-- text into a column the UI renders as labels. The service validates first and
-- returns a 400; this constraint is the database's own backstop.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pt_client_interviews_training_challenges_check'
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_training_challenges_check
      CHECK (
        training_challenges IS NULL OR training_challenges <@ ARRAY[
            'time', 'work_schedule', 'motivation', 'confidence',
            'pain_or_injury', 'fatigue', 'family', 'travel',
            'nutrition', 'gym_access', 'cost', 'other'
          ]::text[]
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN pt_client_interviews.job_details IS
  'What the client''s work involves — role, shifts, time on their feet. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.occupation_other_details IS
  'Details when the Lifestyle Assessment''s occupation_type is other. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.previous_workout_experience IS
  'Structured training history at intake: never/beginner/intermediate/advanced. The current programming fact remains pt_clients.workout_experience_level.';
COMMENT ON COLUMN pt_client_interviews.training_challenges IS
  'Canonical keys: time, work_schedule, motivation, confidence, pain_or_injury, fatigue, family, travel, nutrition, gym_access, cost, other. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.challenge_other IS
  'Free text when training_challenges contains other. Client-stated.';
COMMENT ON COLUMN pt_client_interviews.important_client_statements IS
  'What the client said in their own words. Client-stated, not the trainer''s summary (which is notes).';
