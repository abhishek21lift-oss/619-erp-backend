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

-- ── RLS: both halves, because either alone is broken ───────────────────────
--
-- The deny-all keeps the table off PostgREST with the publishable key, which
-- would otherwise bypass the API and every tenant check in it — and this table
-- holds a client's safety screen, constraints and clinical findings frozen
-- into JSON.
--
-- The tenant_isolation policy and its GRANT are what let the application read
-- and write it AT ALL. The API connects as app_tenant, so a table with RLS on
-- and no app_tenant policy is not a locked-down table, it is a dead one: every
-- insert fails on permission, and because this ledger is written best-effort
-- the failure would be swallowed and the whole feature would be silently inert
-- in production while passing every test that mocks the pool.
--
-- The first draft of this migration had only the deny-all. It took
-- rls.isolation.integration.test.js — which runs against a real Postgres and
-- is skipped locally for want of one — to say so.
ALTER TABLE ai_workout_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_workout_generations FROM anon, authenticated;

DROP POLICY IF EXISTS deny_all_direct_access ON ai_workout_generations;
CREATE POLICY deny_all_direct_access ON ai_workout_generations
  FOR ALL USING (false) WITH CHECK (false);

-- Declared exactly as migration 157 declares every other tenant table's: FOR
-- ALL TO app_tenant, with a WITH CHECK as well as a USING. Without the role
-- the policy does not apply to the one the application connects as; without
-- WITH CHECK it would constrain reads but not writes, so a row could land in
-- another studio even though reads were filtered.
--
-- The strict form rather than 157's `OR organization_id IS NULL` variant: that
-- exists for tables holding platform-seeded rows, and this one starts empty
-- and is only ever written by a request that already has an org.
DROP POLICY IF EXISTS tenant_isolation ON ai_workout_generations;
CREATE POLICY tenant_isolation ON ai_workout_generations FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_workout_generations TO app_tenant;

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

-- ── Verification ───────────────────────────────────────────────────────────
--
-- A migration that silently half-applied is how a ledger ends up unwritable.
-- This makes that an error at apply time rather than a discovery later.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ai_workout_generations'
       AND policyname = 'tenant_isolation' AND 'app_tenant' = ANY(roles)
  ) THEN
    RAISE EXCEPTION '199: tenant_isolation policy for app_tenant is missing — the ledger would be unwritable';
  END IF;

  IF NOT has_table_privilege('app_tenant', 'ai_workout_generations', 'INSERT') THEN
    RAISE EXCEPTION '199: app_tenant cannot INSERT — the ledger would be unwritable';
  END IF;
END $$;

DO $$
DECLARE generations BIGINT; live_plans BIGINT;
BEGIN
  SELECT count(*) INTO generations FROM ai_usage_log WHERE intent_type = 'workout';
  SELECT count(*) INTO live_plans FROM workout_plans
   WHERE deleted_at IS NULL AND parent_plan_id IS NULL;
  RAISE NOTICE '199: % past workout generation(s) and % live plan(s) predate this table and cannot be recovered',
    generations, live_plans;
END $$;
