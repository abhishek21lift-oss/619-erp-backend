-- One goal vocabulary for workout plans.
--
-- workout_plans.goal accepted seven values while pt_goals.goal_type accepted
-- fourteen and the deterministic generator wrote `hypertrophy` and
-- `powerlifting`. A powerlifting client's proposal was saved with goal NULL
-- because plan-materialise dropped the value rather than fail the CHECK.
--
-- The canonical nine are now the programming vocabulary. `weight_loss` and
-- `muscle_gain` stay in the constraint because existing rows carry them and
-- older clients still send them; plan-materialise classifies them to
-- fat_loss and hypertrophy on write. No row is rewritten: a goal a trainer
-- can see is not silently changed underneath them.
--
-- Idempotent; safe to re-run.

ALTER TABLE workout_plans DROP CONSTRAINT IF EXISTS workout_plans_goal_check;
ALTER TABLE workout_plans
  ADD CONSTRAINT workout_plans_goal_check
  CHECK (goal IN (
    'hypertrophy', 'strength', 'fat_loss', 'endurance', 'general_fitness',
    'body_recomposition', 'recovery', 'flexibility_mobility', 'powerlifting',
    'weight_loss', 'muscle_gain'
  ));
