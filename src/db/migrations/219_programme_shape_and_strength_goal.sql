-- ─────────────────────────────────────────────────────────────────────────
-- 219 — A programme's shape: what it says matches what it holds
-- ─────────────────────────────────────────────────────────────────────────
--
-- An audit of the "New programme" sheet (28 Sep) found three fields that
-- described the programme without being true of it. Measured on production:
--
--   sessions_per_week   30 of 35 plans carry a number that disagrees with
--                       the days actually programmed. The builder never read
--                       it — it always offers all seven days — so it was a
--                       label typed before any exercise existed. Yet the
--                       assignment's progress_pct divides by it, so a client
--                       training five days on a plan labelled "3×/week"
--                       reached 100% at week three of five.
--
--   is_template         the create route defaulted it to TRUE when the
--                       field was absent, and the sheet never sent it, so
--                       every client's programme was stored as a template.
--                       9 studio plans assigned to a client were.
--
--   goal                five values, none of them strength. A studio coaching
--                       powerlifters had to call a meet prep "Muscle Gain".
--
-- Idempotent throughout; safe to re-run.

-- ── 1. Strength joins the goals ─────────────────────────────────────────
ALTER TABLE workout_plans DROP CONSTRAINT IF EXISTS workout_plans_goal_check;
ALTER TABLE workout_plans
  ADD CONSTRAINT workout_plans_goal_check
  CHECK (goal IN ('weight_loss','muscle_gain','strength','endurance','general_fitness','recovery'));

-- ── 2. sessions_per_week follows the days that are programmed ───────────
--
-- Counted on week 1, the plan's base week: weeks a trainer has edited carry
-- rows of their own (migration 137) that repeat the same days, and counting
-- them would not change the answer but would cost a wider scan.
--
-- An empty plan keeps whatever it had. A programme that has just been
-- created has no exercises yet, and 0 sessions a week is not a shape — the
-- first exercise added sets the real number. The whole-plan PUT deletes
-- every row before re-inserting, and this rule is also what stops that from
-- flashing the column to zero halfway through.
CREATE OR REPLACE FUNCTION sync_plan_sessions_per_week(p_plan_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  n INT;
BEGIN
  IF p_plan_id IS NULL THEN RETURN; END IF;
  SELECT COUNT(DISTINCT day_of_week) INTO n
    FROM workout_exercises
   WHERE workout_plan_id = p_plan_id AND week_number = 1;
  IF n > 0 THEN
    UPDATE workout_plans
       SET sessions_per_week = n
     WHERE id = p_plan_id AND sessions_per_week IS DISTINCT FROM n;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION trg_workout_exercises_sync_spw()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM sync_plan_sessions_per_week(NEW.workout_plan_id);
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    IF TG_OP = 'DELETE' OR OLD.workout_plan_id IS DISTINCT FROM NEW.workout_plan_id THEN
      PERFORM sync_plan_sessions_per_week(OLD.workout_plan_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS workout_exercises_sync_spw ON workout_exercises;
CREATE TRIGGER workout_exercises_sync_spw
  AFTER INSERT OR DELETE OR UPDATE OF day_of_week, week_number, workout_plan_id
  ON workout_exercises
  FOR EACH ROW EXECUTE FUNCTION trg_workout_exercises_sync_spw();

-- Backfill: every plan that has programmed days takes their count.
UPDATE workout_plans wp
   SET sessions_per_week = d.n
  FROM (SELECT workout_plan_id, COUNT(DISTINCT day_of_week)::INT AS n
          FROM workout_exercises
         WHERE week_number = 1
         GROUP BY workout_plan_id) d
 WHERE d.workout_plan_id = wp.id
   AND wp.sessions_per_week IS DISTINCT FROM d.n;

-- ── 3. A studio's client programme is not a template ────────────────────
--
-- Only plans a studio wrote (organization_id set) that are assigned to a
-- client. Platform-seeded templates (organization_id NULL) are templates by
-- definition and stay so even when a studio assigns one.
UPDATE workout_plans wp
   SET is_template = FALSE
 WHERE wp.is_template = TRUE
   AND wp.organization_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM workout_assignments wa WHERE wa.workout_plan_id = wp.id);
