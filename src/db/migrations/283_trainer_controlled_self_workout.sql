-- 283_trainer_controlled_self_workout.sql
--
-- The trainer decides whether a client may train on their own. Until now the
-- member app let any client with a programme start a guided workout and post
-- the finished result in one request, so the studio had no way to withhold
-- that, and nothing to review afterwards.
--
-- Additive only. The session system stays the canonical one:
--
--   pt_clients.allow_self_workout   the permission, OFF until a trainer sets it
--   workout_sessions.prescribed     the plan day the member was shown, kept
--                                   beside (not instead of) what they did
--   workout_sessions.draft          autosave of an in-progress member session
--   workout_sessions.started_at     when the member started
--   workout_sessions.submitted_at   when they submitted; the immutability stamp
--   workout_sessions.review_status  pending → approved | changes_requested
--   workout_sessions.reviewed_by/at/review_feedback
--   workout_session_exercises.prescribed_index
--                                   aligns actual rows to the prescribed order
--
-- No BEGIN/COMMIT: migrate.js wraps this with the _migrations insert. See
-- migrations.transactionControl.test.js.

ALTER TABLE pt_clients
  ADD COLUMN IF NOT EXISTS allow_self_workout BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE workout_sessions
  ADD COLUMN IF NOT EXISTS prescribed JSONB,
  ADD COLUMN IF NOT EXISTS draft JSONB,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_status TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_feedback TEXT;

ALTER TABLE workout_sessions DROP CONSTRAINT IF EXISTS workout_sessions_review_status_check;
ALTER TABLE workout_sessions ADD CONSTRAINT workout_sessions_review_status_check
  CHECK (review_status IS NULL OR review_status IN ('pending', 'approved', 'changes_requested'));

-- Only a member's own session goes through review; the trainer's log is
-- already the trainer's record and never enters the queue.
ALTER TABLE workout_sessions DROP CONSTRAINT IF EXISTS workout_sessions_review_is_member;
ALTER TABLE workout_sessions ADD CONSTRAINT workout_sessions_review_is_member
  CHECK (review_status IS NULL OR source = 'member');

-- Existing sessions were created when they started; the column is new, so
-- backfill it rather than leaving studio history with no start time.
UPDATE workout_sessions SET started_at = created_at WHERE started_at IS NULL;

ALTER TABLE workout_session_exercises
  ADD COLUMN IF NOT EXISTS prescribed_index INTEGER;

CREATE INDEX IF NOT EXISTS workout_sessions_pending_review_idx
  ON workout_sessions (organization_id, submitted_at DESC)
  WHERE review_status = 'pending';

COMMENT ON COLUMN pt_clients.allow_self_workout IS
  'Trainer-controlled: may this client start a workout in the member app without the trainer?';
COMMENT ON COLUMN workout_sessions.prescribed IS
  'Snapshot of the plan day the member was shown when the session started.';
COMMENT ON COLUMN workout_sessions.draft IS
  'Autosaved in-progress workout; cleared on submit. Never read after submission.';
COMMENT ON COLUMN workout_sessions.started_at IS
  'When the member started the session in the member app (created_at for older rows).';
COMMENT ON COLUMN workout_sessions.submitted_at IS
  'When the member submitted the session. A submitted member session is immutable.';
COMMENT ON COLUMN workout_sessions.review_status IS
  'pending on member submit; approved or changes_requested after trainer review.';
COMMENT ON COLUMN workout_session_exercises.prescribed_index IS
  'Position of this exercise in workout_sessions.prescribed, for planned-vs-actual.';
