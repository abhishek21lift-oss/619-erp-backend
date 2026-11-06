-- ============================================================
-- 268_workout_session_feedback.sql
-- Post-session feedback for trainer-led workout-log sessions.
--
-- 267 assumed every feedback request came from a booked PT session. The
-- studio's normal workflow finishes a workout from the Workout Log, which only
-- writes workout_sessions. Those sessions are canonical training records and
-- have no pt_sessions row, so they need their own link.
--
-- A row now points at exactly one source:
--   · session_id          → a booked pt_sessions row (My Schedule)
--   · workout_session_id  → a workout_sessions row (Finish Workout)
--
-- Existing rows are all session_id, so the new check holds without a backfill.
-- Additive and idempotent.
-- ============================================================

ALTER TABLE pt_session_feedback
  ADD COLUMN IF NOT EXISTS workout_session_id TEXT
    REFERENCES workout_sessions(id) ON DELETE CASCADE;

ALTER TABLE pt_session_feedback
  ALTER COLUMN session_id DROP NOT NULL;

ALTER TABLE pt_session_feedback
  DROP CONSTRAINT IF EXISTS pt_session_feedback_one_source;
ALTER TABLE pt_session_feedback
  ADD CONSTRAINT pt_session_feedback_one_source
  CHECK ((session_id IS NOT NULL) <> (workout_session_id IS NOT NULL));

-- One request per workout session. A UNIQUE constraint still allows many
-- NULLs, so the existing session_id-only rows are unaffected.
ALTER TABLE pt_session_feedback
  DROP CONSTRAINT IF EXISTS pt_session_feedback_workout_session_unique;
ALTER TABLE pt_session_feedback
  ADD CONSTRAINT pt_session_feedback_workout_session_unique
  UNIQUE (workout_session_id);

COMMENT ON COLUMN pt_session_feedback.session_id IS
  'The booked pt_sessions row. NULL when the request came from a workout-log session.';
COMMENT ON COLUMN pt_session_feedback.workout_session_id IS
  'The workout_sessions row the trainer finished. NULL when the request came from a booked session.';

COMMENT ON TABLE pt_session_feedback IS
  'One feedback request per completed PT session or trainer-led workout session, and the client''s submitted answers.';
