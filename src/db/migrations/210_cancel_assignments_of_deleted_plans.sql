-- 210_cancel_assignments_of_deleted_plans.sql
--
-- End the assignments of workout plans that have been deleted.
--
-- Deleting a plan used to set workout_plans.deleted_at and nothing else, so
-- its assignments stayed 'active' or 'paused'. The trainer's client screen
-- kept counting programmes the member app no longer shows (it joins on live
-- plans only): one member had 4 "active" programmes and could see 1.
-- DELETE /api/workouts/plans/:id now cancels them in the same statement; this
-- clears the ones that built up before that.
--
-- ── Measured before writing (production, 2026-09-26) ───────────────────────
--
--   assignments of deleted plans:  20 active, 18 paused, 1 cancelled
--
-- 'cancelled', not 'completed' — the client did not finish the plan, it was
-- withdrawn. Sessions already logged against these assignments are untouched;
-- only the status changes. Idempotent: a second run matches nothing.

UPDATE workout_assignments a
   SET status = 'cancelled', updated_at = NOW()
  FROM workout_plans p
 WHERE p.id = a.workout_plan_id
   AND p.deleted_at IS NOT NULL
   AND a.status IN ('active', 'paused');
