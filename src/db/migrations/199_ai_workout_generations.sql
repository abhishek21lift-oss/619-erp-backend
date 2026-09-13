-- ============================================================
-- 199_ai_workout_generations.sql
-- Keep what the AI proposed, so what the trainer changed is knowable.
-- ============================================================
--
-- ── The measurement that made this necessary ───────────────────────────────
--
-- Taken from the live database before this was written:
--
--   ai_usage_log, intent_type = 'workout'     95 generations
--   workout_plans, live (parent_plan_id NULL)  9 plans
--
-- Ninety-five programmes were generated. Nine live plans exist. Whatever
-- happened to the other eighty-six — a trainer read them and closed the tab,
-- or saved one and replaced it later — is the single most valuable piece of
-- programming feedback this studio has produced, and none of it was kept.
--
-- Nor is the accepted end any better. `POST /api/workouts/plans` has no
-- provenance field, so the moment a generated plan is saved it becomes
-- indistinguishable from one a trainer typed by hand. There is no way to ask
-- "what did the trainer change about what we suggested", because there is no
-- record of what was suggested.
--
-- ── Why a new table rather than an existing one ────────────────────────────
--
-- Two tables look like they might already do this, and neither can:
--
--   · ai_usage_log is token accounting. It stores model, tokens, cost,
--     latency and intent — no client, no content, no link to a plan. Its
--     request_id column is populated on 0 of those 95 rows.
--   · workout_plans.parent_plan_id is the builder's own versioning: a
--     trainer-initiated snapshot of a plan that has ALREADY been saved. A
--     generation nobody accepted never becomes a workout_plans row at all,
--     so the rejection — the most informative case — is invisible to it.
--
-- What is missing is a record of the proposal itself, which is a different
-- thing from a plan and is why this is a new table rather than more columns
-- on an old one.
--
-- ── What it stores, and what it deliberately does not ──────────────────────
--
-- The proposed plan, and the screen and audit AS THEY WERE AT THE TIME. That
-- last part matters: the rules change as this engine is built, and a
-- generation judged against today's rules would be re-scored by tomorrow's,
-- which would make the history unreadable. What was known, and what was
-- decided from it, are frozen together.
--
-- It does NOT store the prompt or the model's raw text. The prompt is
-- reconstructible from the twin; the raw text is the plan, parsed. Storing
-- either would put a copy of the client's clinical picture in a second place
-- for no answerable question.
--
-- ── Tenancy ────────────────────────────────────────────────────────────────
--
-- organization_id is stamped and indexed first in every access path, matching
-- workout_plans. It is nullable for the same reason that one is: a platform
-- operator generating outside any studio. Every read this build issues scopes
-- it anyway rather than relying on the column being set.
--
-- ── Growth ─────────────────────────────────────────────────────────────────
--
-- Production runs about 30 workout generations a month. A proposed plan is
-- 10-50 KB of JSON, so this table grows by roughly 1 MB a month at the
-- current rate. That is small enough to keep whole for now and large enough
-- that it should not be ignored forever; there is no retention policy here
-- because guessing one before anybody has read this data would be inventing a
-- requirement.
--
-- No BEGIN/COMMIT — migrate.js wraps this together with the _migrations insert
-- that records it. See migrations.transactionControl.test.js.

CREATE TABLE IF NOT EXISTS ai_workout_generations (
  id               TEXT PRIMARY KEY,
  organization_id  UUID REFERENCES organizations(id),
  client_id        TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  created_by       TEXT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Correlates one generation with its own ai_usage_log rows and its server
  -- logs. Populated going forward; historical usage rows have none.
  request_id       TEXT,
  model            TEXT,

  -- Did the audit force a second pass, and did that second pass survive?
  revised          BOOLEAN NOT NULL DEFAULT FALSE,
  -- The deterministic rule-breach count, 0-100. See plan-critic.js: it is a
  -- floor on quality, not an estimate of it.
  quality_score    INTEGER,

  proposed_plan    JSONB NOT NULL,
  -- The safety screen and the audit as they stood for THIS generation.
  screen           JSONB,
  audit            JSONB,

  -- NULL until a trainer saves a plan from this proposal. NULL forever is the
  -- common case and the interesting one: the trainer read it and did not use
  -- it.
  accepted_plan_id TEXT REFERENCES workout_plans(id) ON DELETE SET NULL,
  accepted_at      TIMESTAMPTZ
);

-- The read path: this client's recent proposals, newest first.
CREATE INDEX IF NOT EXISTS ai_workout_generations_client_idx
  ON ai_workout_generations (organization_id, client_id, created_at DESC);

-- "What did we suggest that nobody used?" — the question the whole table
-- exists to make answerable.
CREATE INDEX IF NOT EXISTS ai_workout_generations_unaccepted_idx
  ON ai_workout_generations (organization_id, created_at DESC)
  WHERE accepted_plan_id IS NULL;

-- The other direction: given a saved plan, what was proposed for it.
CREATE INDEX IF NOT EXISTS ai_workout_generations_accepted_idx
  ON ai_workout_generations (accepted_plan_id)
  WHERE accepted_plan_id IS NOT NULL;

-- ── Reachable only through the API ─────────────────────────────────────────
--
-- Without this the table is readable through PostgREST with the publishable
-- key, which bypasses the API and every tenant check inside it — and this
-- table holds a client's safety screen, constraints and clinical findings
-- frozen into JSON. Deny-all is the right policy because nothing is meant to
-- reach it except the service role the API connects as.
ALTER TABLE ai_workout_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_workout_generations FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ai_workout_generations'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON ai_workout_generations
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $$;

COMMENT ON TABLE ai_workout_generations IS
  'One row per AI workout generation: what was proposed, what the rules knew '
  'and decided at the time, and whether a trainer accepted it. Written on '
  'generate; accepted_plan_id is set when a plan is saved from the proposal.';

COMMENT ON COLUMN ai_workout_generations.screen IS
  'The safety screen as it stood for THIS generation — gate, constraints, '
  'coverage. Frozen rather than recomputed, so a proposal is always readable '
  'against the rules that actually shaped it.';

COMMENT ON COLUMN ai_workout_generations.accepted_plan_id IS
  'The workout_plans row a trainer saved from this proposal, or NULL. NULL is '
  'the common case and is a finding, not a gap: 95 generations had produced 9 '
  'live plans when this table was added.';

DO $$
DECLARE generations BIGINT; live_plans BIGINT;
BEGIN
  SELECT count(*) INTO generations FROM ai_usage_log WHERE intent_type = 'workout';
  SELECT count(*) INTO live_plans FROM workout_plans
   WHERE deleted_at IS NULL AND parent_plan_id IS NULL;
  RAISE NOTICE '199: % past workout generation(s) and % live plan(s) predate this table and cannot be recovered',
    generations, live_plans;
END $$;
