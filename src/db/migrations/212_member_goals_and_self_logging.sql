-- 212_member_goals_and_self_logging.sql
--
-- Two member-app features that need somewhere to write.
--
-- ── 1. member_goals ────────────────────────────────────────────────────────
--
-- Targets a MEMBER sets for themselves: "squat 100 kg", "20 sessions by
-- December", "reach 72 kg". Progress is never stored — it is read from what
-- was logged (sets, sessions, measurements) every time, so a goal can never
-- disagree with the records it is about.
--
-- Why not pt_goals: that table is the TRAINER's goal assessment (goal type,
-- motivation, lifestyle readiness, a computed Smart Goal Analysis). It has one
-- active row per client and is the studio's record. A member's personal
-- targets sit beside it, and the member app shows the trainer's weight target
-- as the studio goal, read-only.
--
--   kind      what `target_value` measures           progress read from
--   weight    body weight, kg                         measurements + check-ins
--   lift      heaviest completed set, kg (exercise)   workout_sets
--   sessions  training sessions since created_at      workout_sessions
--
-- `start_value` is snapshotted when the goal is set so "how far have I come"
-- stays meaningful. `achieved_at` is stamped the first time the records meet
-- the target, and never cleared: reaching a goal is an event, not a state.
--
-- ── 2. workout_sessions.source / client_request_id ─────────────────────────
--
-- A member can now log a workout they did on their own (guided workout in the
-- member app). The trainer must be able to tell those apart from sessions
-- they ran, so each session says where it came from. Existing rows are all
-- studio sessions — that is the default.
--
-- The member app sends the whole finished workout in one request. A phone on
-- gym wifi retries; client_request_id makes the retry return the session it
-- already created instead of logging the workout twice.
--
-- ── Measured before writing (production, 2026-09-26) ───────────────────────
--
--   workout_sessions: 133 rows, all written by the trainer's workout log.
--   pt_goals: 8 rows, 4 active with a target weight.
--
-- No BEGIN/COMMIT — migrate.js wraps this together with the _migrations insert
-- that records it. See migrations.transactionControl.test.js.

CREATE TABLE IF NOT EXISTS member_goals (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id        TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('weight', 'lift', 'sessions')),
  -- Only for kind = 'lift': the exercise, as it is written in the workout log.
  exercise_name    TEXT CHECK (exercise_name IS NULL OR char_length(btrim(exercise_name)) BETWEEN 1 AND 120),
  start_value      NUMERIC(8,2),
  target_value     NUMERIC(8,2) NOT NULL CHECK (target_value > 0 AND target_value < 100000),
  target_date      DATE,
  achieved_at      TIMESTAMPTZ,
  archived_at      TIMESTAMPTZ,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT member_goals_lift_has_exercise
    CHECK ((kind = 'lift') = (exercise_name IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS member_goals_client_idx
  ON member_goals (organization_id, client_id, created_at DESC)
  WHERE archived_at IS NULL;

ALTER TABLE member_goals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON member_goals FROM anon, authenticated;

DROP POLICY IF EXISTS deny_all_direct_access ON member_goals;
CREATE POLICY deny_all_direct_access ON member_goals
  FOR ALL USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS tenant_isolation ON member_goals;
CREATE POLICY tenant_isolation ON member_goals FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON member_goals TO app_tenant;

COMMENT ON TABLE member_goals IS
  'Personal targets a member sets in the member app. Progress is computed from '
  'the logged records on read; achieved_at is stamped once, the first time the '
  'records meet the target.';

ALTER TABLE workout_sessions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'studio';
ALTER TABLE workout_sessions DROP CONSTRAINT IF EXISTS workout_sessions_source_check;
ALTER TABLE workout_sessions ADD CONSTRAINT workout_sessions_source_check
  CHECK (source IN ('studio', 'member'));

ALTER TABLE workout_sessions ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS workout_sessions_client_request_idx
  ON workout_sessions (client_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

COMMENT ON COLUMN workout_sessions.source IS
  'studio: logged by the trainer. member: logged by the member in the member app.';
COMMENT ON COLUMN workout_sessions.client_request_id IS
  'Idempotency key the member app sends with a finished workout, so a retried '
  'request returns the session it already created.';

-- ── Verification ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'member_goals'
       AND policyname = 'tenant_isolation' AND 'app_tenant' = ANY(roles)
  ) THEN
    RAISE EXCEPTION '212: tenant_isolation policy for app_tenant is missing — goals would be unwritable';
  END IF;

  IF NOT has_table_privilege('app_tenant', 'member_goals', 'INSERT') THEN
    RAISE EXCEPTION '212: app_tenant cannot INSERT member_goals';
  END IF;
END $$;
