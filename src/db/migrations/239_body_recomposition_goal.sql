-- ─────────────────────────────────────────────────────────────────────────
-- 239 — Body recomposition is a goal the column accepts
-- ─────────────────────────────────────────────────────────────────────────
--
-- The AI workout generator is told body_recomposition is one of the goals it
-- may answer (src/lib/ai/prompts/system.js). Migration 219's CHECK did not
-- include it, so plan-materialise dropped the value to NULL rather than fail
-- the save — every recomposition programme was stored with no goal.
--
-- Idempotent; safe to re-run.

ALTER TABLE workout_plans DROP CONSTRAINT IF EXISTS workout_plans_goal_check;
ALTER TABLE workout_plans
  ADD CONSTRAINT workout_plans_goal_check
  CHECK (goal IN (
    'weight_loss','muscle_gain','strength','endurance',
    'general_fitness','body_recomposition','recovery'
  ));

-- Repair what the gap already cost: a plan saved from a proposal whose goal
-- was body_recomposition, stored NULL. The proposal is the only remaining
-- record of what the trainer generated it for.
UPDATE workout_plans wp
   SET goal = 'body_recomposition'
  FROM ai_workout_generations g
 WHERE g.accepted_plan_id = wp.id
   AND wp.goal IS NULL
   AND lower(regexp_replace(btrim(g.proposed_plan->>'goal'), '[[:space:]-]+', '_', 'g'))
       = 'body_recomposition';
