-- ─────────────────────────────────────────────────────────────────────────
-- 220 — Sessions that never happened, and progress that stays true
-- ─────────────────────────────────────────────────────────────────────────
--
-- From the training audit (docs/TRAINING-AUDIT-2026-09-29.md). Production:
--
--   T-1  68 of 136 sessions were still "in progress" on a past date, 56 of
--        them with nothing logged. The hourly sweep completes an old log
--        that has sets done, and deliberately left empty ones alone, so they
--        piled up forever: Ajeet's log read "22 sessions, 7 completed".
--        They become 'abandoned' — kept, not deleted, and counted nowhere.
--
--   T-4  progress_pct was recomputed only when a session completed, so when
--        219 corrected sessions_per_week from the programmed days, every
--        stored percentage kept the old denominator (Ajeet: 8% for 1 of 4).
--        It is now recomputed whenever a plan's size changes.
--
--   T-5  5 sessions logged against a programme — its name and weekday on the
--        row — were never linked to the assignment, by a code path that has
--        since been fixed. Unlinked sessions count toward no programme.
--
--   T-8  A session marked complete with nothing done counted as a workout.
--        Progress now counts completed sessions with at least one set done.
--
-- Idempotent; safe to re-run.

-- ── 1. 'abandoned' ──────────────────────────────────────────────────────
ALTER TABLE workout_sessions DROP CONSTRAINT IF EXISTS workout_sessions_status_check;
ALTER TABLE workout_sessions
  ADD CONSTRAINT workout_sessions_status_check
  CHECK (status IN ('in_progress', 'completed', 'abandoned'));

-- ── 2. One rule for progress ────────────────────────────────────────────
--
-- Completed sessions linked to the assignment that have at least one set
-- marked done, over the plan's target (sessions a week × weeks), capped at
-- 100. The service's recomputeAssignmentProgress calls this, so the rule
-- exists once.
CREATE OR REPLACE FUNCTION recompute_assignment_progress(p_assignment_id TEXT)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  target INT;
  done   INT;
  pct    INT;
BEGIN
  IF p_assignment_id IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(wp.sessions_per_week, 0) * COALESCE(wp.duration_weeks, 0)
    INTO target
    FROM workout_assignments wa
    JOIN workout_plans wp ON wp.id = wa.workout_plan_id
   WHERE wa.id = p_assignment_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COUNT(DISTINCT ws.id) INTO done
    FROM workout_sessions ws
   WHERE ws.workout_assignment_id = p_assignment_id
     AND ws.status = 'completed'
     AND EXISTS (SELECT 1 FROM workout_session_exercises wse
                   JOIN workout_sets s ON s.session_exercise_id = wse.id
                  WHERE wse.session_id = ws.id AND s.completed = TRUE);

  pct := CASE WHEN target > 0 THEN LEAST(100, ROUND(done * 100.0 / target)::INT) ELSE 0 END;

  UPDATE workout_assignments
     SET progress_pct = pct, updated_at = NOW()
   WHERE id = p_assignment_id AND progress_pct IS DISTINCT FROM pct;
  RETURN pct;
END;
$$;

-- A plan that changes size — sessions a week (219's trigger keeps it equal
-- to the programmed days) or weeks — moves every running assignment's
-- percentage with it.
CREATE OR REPLACE FUNCTION trg_workout_plans_recompute_progress()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sessions_per_week IS DISTINCT FROM OLD.sessions_per_week
     OR NEW.duration_weeks IS DISTINCT FROM OLD.duration_weeks THEN
    PERFORM recompute_assignment_progress(wa.id)
       FROM workout_assignments wa
      WHERE wa.workout_plan_id = NEW.id AND wa.status = 'active';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS workout_plans_recompute_progress ON workout_plans;
CREATE TRIGGER workout_plans_recompute_progress
  AFTER UPDATE OF sessions_per_week, duration_weeks ON workout_plans
  FOR EACH ROW EXECUTE FUNCTION trg_workout_plans_recompute_progress();

-- ── 2b. Which week's rows a date's workout comes from ──────────────────
--
-- T-3: the Today roster counted week 1's exercises whatever week the client
-- was in, while the logged session resolves their current week — so a plan
-- whose later weeks were edited showed one count and logged another.
--
-- This is progression.resolveWeek's anchor, in SQL, so the two cannot
-- differ: the programme week is weeks since the assignment started, held to
-- the plan's length (progression.programmeWeek); the rows used are those of
-- the LATEST week at or before it that has rows of its own for that weekday
-- (an edit in week 4 carries into weeks 5+), else week 1. Per weekday,
-- because resolveWeek is handed one weekday's rows.
DROP FUNCTION IF EXISTS plan_effective_week(TEXT, DATE, DATE);
CREATE OR REPLACE FUNCTION plan_effective_week(p_plan_id TEXT, p_start DATE, p_on DATE, p_dow INT)
RETURNS INT LANGUAGE sql STABLE AS $$
  WITH w AS (
    SELECT LEAST(
             GREATEST(1, ((p_on - p_start) / 7) + 1),
             GREATEST(1, COALESCE((SELECT duration_weeks FROM workout_plans WHERE id = p_plan_id), 1))
           ) AS n
  )
  SELECT COALESCE(
           (SELECT MAX(we.week_number) FROM workout_exercises we, w
             WHERE we.workout_plan_id = p_plan_id
               AND we.day_of_week = p_dow
               AND we.week_number <= w.n),
           1)
$$;

-- ── 2c. Progress follows the sets, not only the session ────────────────
--
-- Progress counts a completed session only while it has a set done, so
-- ticking, unticking or deleting a set on a completed session changes the
-- percentage. The set routes did not recompute; this does, for every writer.
CREATE OR REPLACE FUNCTION trg_workout_sets_recompute_progress()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  a_id TEXT;
BEGIN
  SELECT ws.workout_assignment_id INTO a_id
    FROM workout_session_exercises wse
    JOIN workout_sessions ws ON ws.id = wse.session_id
   WHERE wse.id = COALESCE(NEW.session_exercise_id, OLD.session_exercise_id)
     AND ws.status = 'completed';
  IF a_id IS NOT NULL THEN
    PERFORM recompute_assignment_progress(a_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS workout_sets_recompute_progress ON workout_sets;
CREATE TRIGGER workout_sets_recompute_progress
  AFTER INSERT OR DELETE OR UPDATE OF completed ON workout_sets
  FOR EACH ROW EXECUTE FUNCTION trg_workout_sets_recompute_progress();

-- ── 3. Link programme sessions that were never linked ───────────────────
--
-- Only rows that name the programme: same client, program_name equal to the
-- plan's name, and the assignment live on the session's date. A freestyle
-- session carries no programme name and stays unlinked, as chosen.
WITH pick AS (
  SELECT DISTINCT ON (ws.id) ws.id AS session_id, wa.id AS assignment_id
    FROM workout_sessions ws
    JOIN workout_assignments wa ON wa.client_id = ws.client_id
    JOIN workout_plans wp ON wp.id = wa.workout_plan_id
   WHERE ws.workout_assignment_id IS NULL
     AND ws.program_name IS NOT NULL
     AND lower(btrim(ws.program_name)) = lower(btrim(wp.name))
     AND wa.status = 'active'
     AND wa.start_date <= ws.session_date
     AND (wa.end_date IS NULL OR wa.end_date >= ws.session_date)
     AND wa.organization_id IS NOT DISTINCT FROM ws.organization_id
   ORDER BY ws.id, wa.start_date DESC
)
UPDATE workout_sessions ws
   SET workout_assignment_id = pick.assignment_id, updated_at = NOW()
  FROM pick
 WHERE ws.id = pick.session_id
   AND ws.workout_assignment_id IS NULL;

-- ── 4. Every running assignment, recomputed under the rule above ────────
DO $$
BEGIN
  PERFORM recompute_assignment_progress(id) FROM workout_assignments WHERE status = 'active';
END $$;
