-- ============================================================
-- 197_workout_assignment_lifecycle.sql
-- Let an assignment stop being active, without letting it fork.
-- ============================================================
--
-- `workout_assignments.status` has a CHECK constraint promising four states:
--
--   CHECK (status = ANY (ARRAY['active','completed','paused','cancelled']))
--
-- and no code in the repository has ever written any value but 'active'. The
-- INSERT sets it; the only UPDATEs touch progress_pct. All 53 production rows
-- are 'active'. The column is not a lifecycle, it is a constant that looks
-- like one — and every read that filters `status = 'active'` is therefore
-- filtering on nothing.
--
-- What that costs, measured before this migration:
--
--   active assignments                         53
--     …whose client is active                  25
--     …whose client is 'pending'               14
--     …whose client is 'expired'               13
--     …whose client is soft-deleted             1
--
-- 28 of 53 belong to somebody who is not a live client. Nothing retires an
-- assignment when a package ends, so a client keeps being rostered by the
-- programme they were last on. #129 stopped the Today panel believing it, by
-- checking the client at read time. This fixes the data underneath.
--
-- ── Why the unique key has to change first ─────────────────────────────────
--
-- The table is keyed:
--
--   UNIQUE (workout_plan_id, client_id, status)
--
-- Status is part of row IDENTITY. So the moment an assignment can become
-- 'paused', the same plan can be assigned to the same client again: the INSERT
-- finds no conflict on (plan, client, 'active') because the existing row is
-- 'paused', and a second row appears. One client, one plan, two rows.
--
-- That is precisely the multiple-active-assignments condition that made a
-- client's programme invisible on the dashboard (#127) — the LATERAL that
-- resolves "which plan is this client on" had more than one row to choose
-- from and picked on recency. Implementing the lifecycle on the current key
-- would reintroduce the bug class that fix was written for.
--
-- So: UNIQUE (workout_plan_id, client_id). One row per client per plan, in
-- any state. The status column then carries the state instead of defining
-- which row it is, which is what it should always have done.
--
-- routes/workouts.js is updated in the same change — its
-- `ON CONFLICT (workout_plan_id, client_id, status)` names the constraint
-- being dropped here and would fail at runtime the moment this ran without
-- it. The two must ship together.
--
-- ── Which retired state, and why not just one ──────────────────────────────
--
--   paused     the client is expired or pending — they may well come back,
--              and when they do the write path flips this straight back to
--              active. Reversible, and reads already ignore it.
--   cancelled  the client is soft-deleted. They are not coming back, and
--              nothing should resurrect their programme.
--
-- Nothing is deleted. Every row keeps its plan, its dates, its progress and
-- its notes; only `status` moves. A studio that reactivates a client gets
-- their programme back exactly as it was.
--
-- ── No BEGIN/COMMIT here, deliberately ─────────────────────────────────────
--
-- migrate.js wraps every migration together with the `INSERT INTO _migrations`
-- that records it. A migration that opens its own transaction closes the
-- runner's early. Enforced by migrations.transactionControl.test.js.

-- ------------------------------------------------------------
-- 1. Refuse rather than corrupt.
--
--    The new key is narrower than the old one, so it can only be created if
--    no (plan, client) pair already has more than one row. Verified zero in
--    production before writing this, but a migration that assumes its own
--    precondition is a migration that silently destroys data on the one
--    database where the assumption is false.
-- ------------------------------------------------------------
DO $$
DECLARE colliding BIGINT;
BEGIN
  SELECT count(*) INTO colliding FROM (
    SELECT workout_plan_id, client_id
      FROM workout_assignments
     GROUP BY workout_plan_id, client_id
    HAVING count(*) > 1
  ) z;

  IF colliding > 0 THEN
    RAISE EXCEPTION '197 refused: % (workout_plan_id, client_id) pair(s) already hold more than one assignment row, so UNIQUE (workout_plan_id, client_id) cannot be created without losing one of them. Merge or retire the duplicates first, then re-run.', colliding;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Retire the assignments of clients who are not live.
--
--    Runs BEFORE the key swap, while the old key still holds — retiring is a
--    status change, and under the OLD key a status change is an identity
--    change, so it could in principle collide with an existing row of the
--    target status. It cannot here (nothing is anything but 'active'), and
--    after step 3 the question disappears entirely.
--
--    Idempotent: re-running retires anything that has since lapsed and
--    rewrites nothing already retired.
-- ------------------------------------------------------------
UPDATE workout_assignments a
   SET status = 'cancelled', updated_at = NOW()
  FROM pt_clients c
 WHERE c.id = a.client_id
   AND c.deleted_at IS NOT NULL
   AND a.status = 'active';

UPDATE workout_assignments a
   SET status = 'paused', updated_at = NOW()
  FROM pt_clients c
 WHERE c.id = a.client_id
   AND c.deleted_at IS NULL
   AND c.status IS DISTINCT FROM 'active'
   AND a.status = 'active';

-- An assignment whose client row is gone entirely cannot be judged, and the
-- FK is ON DELETE CASCADE so this should be unreachable. Retired rather than
-- left active on the chance that it is not.
UPDATE workout_assignments a
   SET status = 'cancelled', updated_at = NOW()
 WHERE a.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM pt_clients c WHERE c.id = a.client_id);

-- ------------------------------------------------------------
-- 3. Swap the key: status stops being part of identity.
-- ------------------------------------------------------------
ALTER TABLE workout_assignments
  DROP CONSTRAINT IF EXISTS workout_assignments_workout_plan_id_client_id_status_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'workout_assignments'::regclass
       AND conname  = 'workout_assignments_plan_client_key'
  ) THEN
    ALTER TABLE workout_assignments
      ADD CONSTRAINT workout_assignments_plan_client_key
      UNIQUE (workout_plan_id, client_id);
    RAISE NOTICE '197: unique key is now (workout_plan_id, client_id)';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. The index the Today rule reads through.
--
--    getTodayRoster filters active assignments by client and date window on
--    every dashboard and /pt-os/today load. Partial, because every one of
--    those reads asks only about active rows.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS workout_assignments_active_client_idx
  ON workout_assignments (client_id, start_date DESC)
  WHERE status = 'active';

-- ------------------------------------------------------------
-- 5. Report the end state rather than assume it.
-- ------------------------------------------------------------
DO $$
DECLARE total BIGINT; act BIGINT; paused BIGINT; cancelled BIGINT; stale BIGINT;
BEGIN
  SELECT count(*) INTO total     FROM workout_assignments;
  SELECT count(*) INTO act       FROM workout_assignments WHERE status = 'active';
  SELECT count(*) INTO paused    FROM workout_assignments WHERE status = 'paused';
  SELECT count(*) INTO cancelled FROM workout_assignments WHERE status = 'cancelled';

  SELECT count(*) INTO stale
    FROM workout_assignments a
    JOIN pt_clients c ON c.id = a.client_id
   WHERE a.status = 'active'
     AND (c.deleted_at IS NOT NULL OR c.status IS DISTINCT FROM 'active');

  RAISE NOTICE '197: % assignment(s) — % active, % paused, % cancelled', total, act, paused, cancelled;

  IF stale > 0 THEN
    RAISE EXCEPTION '197 failed its own check: % assignment(s) are still active for a client who is not. The retirement in step 2 did not cover them.', stale;
  END IF;
END $$;

COMMENT ON COLUMN workout_assignments.status IS
  'active | paused | cancelled | completed. Maintained by the client write '
  'path: a client leaving active status pauses their assignments, returning '
  'to active restores them, and soft-deleting a client cancels them. Reads '
  'that mean "the programme this client is on now" filter status = ''active''.';
