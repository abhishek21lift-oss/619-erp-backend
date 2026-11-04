-- ============================================================
-- 263_goal_secondary_goals.sql
-- Goal setting — secondary fitness goals.
--
-- A client has one primary goal: pt_goals.is_active and
-- deactivateOtherGoals() enforce that, and member self-service goals live in
-- member_goals. Secondary goals are a list on the same primary goal record,
-- not extra pt_goals rows, so they cannot compete with the active-goal rule
-- or appear as a duplicate in the member portal.
--
-- Shape (validated by zod before it reaches here):
--   [{ id, title, goal_type, description, target_date }]
--
-- Additive and nullable. Existing goals read as "no secondary goals".
-- Idempotent; safe to re-run.
-- ============================================================

ALTER TABLE pt_goals
  ADD COLUMN IF NOT EXISTS secondary_goals JSONB;

COMMENT ON COLUMN pt_goals.secondary_goals IS
  'Optional list of secondary fitness goals attached to the primary goal record. Never used for the active-goal rule.';
