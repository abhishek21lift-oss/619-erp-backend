-- ─────────────────────────────────────────────────────────────────────────
-- 228 — One set number per exercise, per session
-- ─────────────────────────────────────────────────────────────────────────
--
-- POST /workout-log/exercises/:id/sets inserted without checking whether the
-- (session_exercise_id, set_number) pair was already taken, and 068's index
-- on those columns is non-unique. A double-tap, or a resend after a timeout,
-- therefore filed the same set twice: duplicate rows in the session detail
-- and double-counted volume in every analytics read.
--
-- The route now refuses an insert whose pair already exists (409), and this
-- index is the database's own guarantee of the same rule — it is what catches
-- two requests racing between that check and their inserts.
--
-- Safe to roll out: it adds an index and changes no data. If duplicates
-- already exist (that is the bug itself), it does NOT delete them — logged
-- sets are training history. It skips the index and says so, and the route's
-- own check still refuses new duplicates. Idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workout_sets
     GROUP BY session_exercise_id, set_number HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE '228: duplicate workout set numbers exist; unique index not created. Review them by hand.';
  ELSE
    -- Replaces 068's non-unique index: same columns, and uniqueness is what
    -- every lookup through it now needs to hold.
    DROP INDEX IF EXISTS wsets_exercise_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS wsets_session_exercise_number_uidx
      ON workout_sets (session_exercise_id, set_number);
  END IF;
END $$;
