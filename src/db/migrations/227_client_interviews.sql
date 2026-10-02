-- ─────────────────────────────────────────────────────────────────────────
-- 227 — The Client Interview
-- ─────────────────────────────────────────────────────────────────────────
--
-- The intake journey is Registration → Informed Consent → PAR-Q → Client
-- Interview → Fitness Assessment → Goals → PT Enrolment → Workout Plan. Every
-- step had a record except the interview: the conversation in which the
-- trainer learns the client's training history, what hurts, how they live,
-- why they came and when they can train. It lived in a notebook or nowhere.
--
-- One row per interview; a client may be re-interviewed, and the newest
-- completed one is current. Optional in the journey (studio decision, Phase 2,
-- 2026-10-02): it shows as a step with its status and never blocks enrolment.
-- Free text throughout, bounded, because this is a conversation written down,
-- not a scored form.
--
-- Same tenancy shape as every client child table (migration 212): the
-- organization on the row, deny-all for direct access, and a tenant policy for
-- app_tenant. No existing data changes.
--
-- No BEGIN/COMMIT — migrate.js wraps this together with the _migrations insert.

CREATE TABLE IF NOT EXISTS pt_client_interviews (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id          TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  training_history   TEXT CHECK (training_history IS NULL OR char_length(training_history) <= 2000),
  pain_and_injuries  TEXT CHECK (pain_and_injuries IS NULL OR char_length(pain_and_injuries) <= 2000),
  lifestyle          TEXT CHECK (lifestyle IS NULL OR char_length(lifestyle) <= 2000),
  motivation         TEXT CHECK (motivation IS NULL OR char_length(motivation) <= 2000),
  availability       TEXT CHECK (availability IS NULL OR char_length(availability) <= 1000),
  preferences        TEXT CHECK (preferences IS NULL OR char_length(preferences) <= 1000),
  notes              TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  interviewed_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pt_client_interviews_completed_at
    CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS pt_client_interviews_client_idx
  ON pt_client_interviews (organization_id, client_id, created_at DESC);

ALTER TABLE pt_client_interviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pt_client_interviews FROM anon, authenticated;

DROP POLICY IF EXISTS deny_all_direct_access ON pt_client_interviews;
CREATE POLICY deny_all_direct_access ON pt_client_interviews
  FOR ALL USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS tenant_isolation ON pt_client_interviews;
CREATE POLICY tenant_isolation ON pt_client_interviews FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON pt_client_interviews TO app_tenant;

COMMENT ON TABLE pt_client_interviews IS
  'The Client Interview step of the intake journey (migration 227). Optional; the newest completed row is current.';
