-- ============================================================
-- 281_ai_diet_generations.sql
-- Keep what the diet engine proposed, so what the trainer did with it is
-- knowable.
-- ============================================================
--
-- The workout generator has kept this record since 199. The diet generator
-- has not, and the cost is the same one 199 describes: a plan nobody accepted
-- leaves no trace, so there is no way to ask which proposals were ignored,
-- which were revised, or which numbers a trainer overrode before saving.
--
-- A generation is not a plan. `diet_templates` holds what was accepted; this
-- table holds what was PROPOSED, with the screen it was judged against:
--
--   calculation   the deterministic targets the plan had to hit
--   schedule      the meal slots and clock times it had to follow
--   validation    the blocker/warning result after the bounded revision
--   grounding     corpus version and the citations that survived checks
--   inputs        the resolved client facts (record-first)
--
-- It deliberately does NOT store the prompt or the model's raw text: the
-- prompt is reconstructible, the raw text is the parsed plan. Storing either
-- would put a second copy of the client's clinical picture in the database
-- for no answerable question.
--
-- ── The accepted end ───────────────────────────────────────────────────────
--
-- accepted_template_id / accepted_assignment_id are filled by the save path
-- when a trainer accepts this generation. NULL is the honest answer for "we
-- suggested it and nobody used it", which is the most valuable row here.
--
-- ── Tenancy ────────────────────────────────────────────────────────────────
--
-- Strict tenant policy, no global rows: unlike `foods`, there is no platform
-- seed to read. organization_id is nullable for the same reason 199's is (a
-- platform operator generating outside a studio), but every read this build
-- issues scopes it, and the policy refuses a NULL org rather than treating it
-- as visible to everyone.

CREATE TABLE IF NOT EXISTS ai_diet_generations (
  id                   TEXT PRIMARY KEY,
  organization_id      UUID REFERENCES organizations(id),
  client_id            TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  created_by           TEXT REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  request_id           TEXT,
  model                TEXT,
  revised              BOOLEAN NOT NULL DEFAULT FALSE,

  proposed_plan        JSONB NOT NULL,
  inputs               JSONB,
  data_quality         JSONB,
  calculation          JSONB,
  schedule             JSONB,
  validation           JSONB,
  grounding            JSONB,
  engine_version       TEXT,
  prompt_version       TEXT,

  accepted_template_id   TEXT REFERENCES diet_templates(id) ON DELETE SET NULL,
  accepted_assignment_id TEXT REFERENCES diet_assignments(id) ON DELETE SET NULL,
  accepted_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ai_diet_generations_client_idx
  ON ai_diet_generations (organization_id, client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_diet_generations_unaccepted_idx
  ON ai_diet_generations (organization_id, created_at DESC)
  WHERE accepted_template_id IS NULL;
CREATE INDEX IF NOT EXISTS ai_diet_generations_accepted_idx
  ON ai_diet_generations (accepted_template_id)
  WHERE accepted_template_id IS NOT NULL;

ALTER TABLE ai_diet_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_diet_generations FROM anon, authenticated;

DROP POLICY IF EXISTS deny_all_direct_access ON ai_diet_generations;
CREATE POLICY deny_all_direct_access ON ai_diet_generations
  FOR ALL USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS tenant_isolation ON ai_diet_generations;
CREATE POLICY tenant_isolation ON ai_diet_generations FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_diet_generations TO app_tenant;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ai_diet_generations'
       AND policyname = 'tenant_isolation' AND 'app_tenant' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'ai_diet_generations tenant_isolation policy for app_tenant is missing';
  END IF;

  IF NOT has_table_privilege('app_tenant', 'ai_diet_generations', 'INSERT') THEN
    RAISE EXCEPTION 'app_tenant lacks INSERT on ai_diet_generations';
  END IF;

  IF NOT has_table_privilege('app_tenant', 'ai_diet_generations', 'SELECT') THEN
    RAISE EXCEPTION 'app_tenant lacks SELECT on ai_diet_generations';
  END IF;
END $$;
