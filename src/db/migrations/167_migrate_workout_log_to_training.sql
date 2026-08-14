-- ============================================================
-- 167_migrate_workout_log_to_training.sql
--
-- Copies the old workout log (068) into the training domain (165).
--
--   workout_sessions          → training_sessions
--   workout_session_exercises → exercise_performances
--   workout_sets              → set_performances
--
-- ── This migration copies. It deletes nothing. ─────────────────────────────
--
-- The old tables are left exactly as they are, still readable by the old
-- endpoints. Dropping them belongs in a later migration, run only once the
-- new tables have been serving production and the counts have been checked,
-- because a backfill and the removal of its own source in one step has no way
-- back if the mapping is wrong.
--
-- ── Re-running is safe ─────────────────────────────────────────────────────
--
-- Every inserted row carries where it came from, and every insert is guarded
-- on that provenance:
--
--   training_sessions.metadata->>'migrated_from'    = 'workout_sessions:<id>'
--   exercise_performances.metadata->>'migrated_from'= 'workout_session_exercises:<id>'
--   set_performances.client_token                    = 'legacy:<workout_sets id>'
--
-- The set guard is free: sp_client_token_uniq already enforces one row per
-- token, so a second run inserts nothing rather than duplicating a workout.
-- Using the idempotency key the logger already uses, rather than inventing a
-- migration-only column, means there is one mechanism to understand.
--
-- ── What the old schema could not say ──────────────────────────────────────
--
-- Recorded honestly as NULL rather than guessed:
--
--   section              old rows had no warm-up/main/accessory grouping
--   workout_template_id  old workout_plans are not workout_templates; linking
--                        them is a separate decision, not a data copy
--   assignment_id        same, for workout_assignments
--   planned_*            the old log stored what was done, never what was asked
--   set_type             everything becomes WORKING, which is what an
--                        untyped set meant in practice
--
-- started_at and completed_at are the only approximations, and they are
-- marked as such in metadata: the old table stored no clock, only created_at
-- and updated_at, so a completed session's completed_at is its last write.
-- That is wrong by however long the trainer took to close it, and it is still
-- better than a COMPLETED session with no completion time, which every
-- "sessions this week" query would silently drop.
--
-- ── Personal records are NOT backfilled here ───────────────────────────────
--
-- They cannot be, correctly. A record depends on what the client's best was
-- at the time, so the history has to be replayed in date order through the
-- same rules the live code uses (modules/training/records.js) — Epley capped
-- at 12 reps, lower-is-better for time and pace, one live record per key.
-- Reimplementing that in SQL would give two implementations to keep in step,
-- and the one that drifts would quietly award wrong records.
--
-- scripts/backfill-training-records.js does it by calling that module. It is
-- idempotent and must be run after this migration — until it does,
-- personal_records is empty for migrated clients, and the FIRST new session
-- a client completes will read as a PR even when their real best is heavier.
-- ============================================================

-- ── Provenance lookups ──────────────────────────────────────────────────────
--
-- The guards below scan on metadata->>'migrated_from'. Without these the
-- migration is O(rows²) against a large log, and re-running it — which is
-- meant to be cheap — is the slowest thing in the deploy.
CREATE INDEX IF NOT EXISTS tsess_migrated_from_idx
  ON training_sessions ((metadata->>'migrated_from'));
CREATE INDEX IF NOT EXISTS ep_migrated_from_idx
  ON exercise_performances ((metadata->>'migrated_from'));

-- ── Sessions ────────────────────────────────────────────────────────────────
INSERT INTO training_sessions (
  organization_id, client_id, trainer_id, created_by,
  session_date, started_at, completed_at, duration_seconds,
  status, template_name, trainer_notes, metadata, created_at, updated_at
)
SELECT
  ws.organization_id,
  ws.client_id,
  ws.trainer_id,
  ws.created_by,
  ws.session_date,
  ws.created_at,
  CASE WHEN ws.status = 'completed' THEN GREATEST(ws.updated_at, ws.created_at) END,
  ws.duration_minutes * 60,
  CASE ws.status WHEN 'completed' THEN 'COMPLETED' ELSE 'IN_PROGRESS' END,
  -- "Push Pull Legs — Day 2", or whichever half exists.
  NULLIF(CONCAT_WS(' — ', NULLIF(ws.program_name, ''), NULLIF(ws.workout_day, '')), ''),
  -- The old log was a trainer's tool: one notes field, written by the person
  -- running the session. Landing it in client_notes would attribute it to the
  -- client, which is a different claim.
  ws.notes,
  jsonb_build_object(
    'migrated_from', 'workout_sessions:' || ws.id,
    'migrated_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SSZ'),
    'approximate_timestamps', true
  ),
  ws.created_at,
  ws.updated_at
FROM workout_sessions ws
WHERE ws.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM training_sessions ts
     WHERE ts.metadata->>'migrated_from' = 'workout_sessions:' || ws.id
  );

-- ── Exercises performed ─────────────────────────────────────────────────────
INSERT INTO exercise_performances (
  session_id, exercise_id, exercise_name, order_index,
  status, notes, started_at, completed_at, metadata, created_at, updated_at
)
SELECT
  ts.id,
  wse.exercise_id,
  wse.exercise_name,
  wse.sort_order,
  -- An exercise with a completed set was performed; one with only unticked
  -- sets was written down and not done.
  CASE WHEN EXISTS (
    SELECT 1 FROM workout_sets s
     WHERE s.session_exercise_id = wse.id AND s.completed
  ) THEN 'COMPLETED' ELSE 'PENDING' END,
  wse.notes,
  ts.started_at,
  CASE WHEN ts.status = 'COMPLETED' AND EXISTS (
    SELECT 1 FROM workout_sets s
     WHERE s.session_exercise_id = wse.id AND s.completed
  ) THEN ts.completed_at END,
  jsonb_build_object('migrated_from', 'workout_session_exercises:' || wse.id),
  wse.created_at,
  wse.created_at
FROM workout_session_exercises wse
JOIN workout_sessions ws ON ws.id = wse.session_id
JOIN training_sessions ts
  ON ts.metadata->>'migrated_from' = 'workout_sessions:' || ws.id
WHERE NOT EXISTS (
  SELECT 1 FROM exercise_performances ep
   WHERE ep.metadata->>'migrated_from' = 'workout_session_exercises:' || wse.id
);

-- ── Sets ────────────────────────────────────────────────────────────────────
INSERT INTO set_performances (
  exercise_performance_id, set_number, set_type,
  actual_reps, actual_weight, weight_unit, actual_rpe, actual_rir,
  tempo, rest_seconds, completed, notes, client_token, metadata,
  created_at, updated_at
)
SELECT
  ep.id,
  -- The old column was an unconstrained INTEGER; the new one is 1–99. A row
  -- outside that range would abort the whole migration, so it is clamped and
  -- the original kept in metadata rather than lost or left to fail.
  LEAST(GREATEST(wset.set_number, 1), 99),
  'WORKING',
  wset.reps,
  wset.weight_kg,
  'kg',
  wset.rpe,
  wset.rir,
  wset.tempo,
  wset.rest_seconds,
  wset.completed,
  wset.notes,
  'legacy:' || wset.id,
  -- The old PR booleans are kept verbatim. They are not authoritative — they
  -- said "was a PR when written" and were never revisited — but they are
  -- evidence, and the backfill script has no other record of what the old
  -- system believed.
  jsonb_build_object(
    'migrated_from', 'workout_sets:' || wset.id,
    'legacy_pr', jsonb_build_object(
      'weight', wset.is_pr_weight,
      'reps',   wset.is_pr_reps,
      'volume', wset.is_pr_volume
    )
  ) || CASE WHEN wset.set_number BETWEEN 1 AND 99
            THEN '{}'::jsonb
            ELSE jsonb_build_object('original_set_number', wset.set_number) END,
  wset.created_at,
  wset.updated_at
FROM workout_sets wset
JOIN workout_session_exercises wse ON wse.id = wset.session_exercise_id
JOIN exercise_performances ep
  ON ep.metadata->>'migrated_from' = 'workout_session_exercises:' || wse.id
WHERE NOT EXISTS (
  SELECT 1 FROM set_performances sp WHERE sp.client_token = 'legacy:' || wset.id
);
