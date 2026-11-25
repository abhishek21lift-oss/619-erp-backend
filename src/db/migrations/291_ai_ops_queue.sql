-- 291_ai_ops_queue.sql
-- The trainer's AI Ops Queue: one attention item per client/lead, plus an
-- append-only audit of every transition.
--
-- ids are TEXT because pt_clients.id / pt_leads.id / users.id are TEXT.
-- Casting them to UUID is the bug class user-id-columns.test.js documents.
--
-- The unique key is one row per subject per organization, reused across
-- episodes: the item moves through statuses instead of creating a second
-- history row when it reopens.

CREATE TABLE IF NOT EXISTS ai_ops_items (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id          TEXT        REFERENCES pt_clients(id) ON DELETE CASCADE,
  lead_id            TEXT        REFERENCES pt_leads(id) ON DELETE CASCADE,
  dedupe_key         TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','snoozed','actioned','dismissed','resolved')),
  priority_score     INT         NOT NULL DEFAULT 0 CHECK (priority_score BETWEEN 0 AND 100),
  priority_band      TEXT        NOT NULL DEFAULT 'low'
                     CHECK (priority_band IN ('critical','high','medium','low')),
  reasons            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  next_due_at        TIMESTAMPTZ,
  recommended_action JSONB,
  draft              JSONB,
  closed_reasons     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  closed_score       INT         NOT NULL DEFAULT 0,
  snoozed_until      TIMESTAMPTZ,
  dismissed_reason   TEXT,
  last_contacted_at  TIMESTAMPTZ,
  last_actioned_at   TIMESTAMPTZ,
  last_error         JSONB,
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_ops_items_org_dedupe UNIQUE (organization_id, dedupe_key),
  CONSTRAINT ai_ops_items_one_subject CHECK (num_nonnulls(client_id, lead_id) = 1)
);

CREATE INDEX IF NOT EXISTS ai_ops_items_open_idx
  ON ai_ops_items (organization_id, status, priority_score DESC);
CREATE INDEX IF NOT EXISTS ai_ops_items_client_idx
  ON ai_ops_items (organization_id, client_id);
CREATE INDEX IF NOT EXISTS ai_ops_items_lead_idx
  ON ai_ops_items (organization_id, lead_id);
CREATE INDEX IF NOT EXISTS ai_ops_items_updated_idx
  ON ai_ops_items (organization_id, updated_at DESC);

DROP TRIGGER IF EXISTS ai_ops_items_set_updated_at ON ai_ops_items;
CREATE TRIGGER ai_ops_items_set_updated_at
  BEFORE UPDATE ON ai_ops_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ai_ops_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id         UUID        REFERENCES ai_ops_items(id) ON DELETE SET NULL,
  event_type      TEXT        NOT NULL CHECK (event_type IN (
                    'created','reasons_updated','brief_generated','draft_generated',
                    'approved','edited','sent','send_failed',
                    'snoozed','dismissed','resolved','reopened')),
  actor_user_id   TEXT,
  actor_role      TEXT,
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_ops_events_item_idx
  ON ai_ops_events (organization_id, item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_ops_events_brief_idx
  ON ai_ops_events (organization_id, event_type, created_at DESC);

-- ── Tenant isolation: items ────────────────────────────────────────────────
-- Same shape as the rest of the tenant tables: deny direct access, then let
-- app_tenant see only rows for the organization in the request context.

ALTER TABLE ai_ops_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_ops_items FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON ai_ops_items;
CREATE POLICY deny_all_direct_access ON ai_ops_items
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON ai_ops_items;
CREATE POLICY tenant_isolation ON ai_ops_items FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_ops_items TO app_tenant;

-- ── Append-only audit ──────────────────────────────────────────────────────
-- REVOKE ALL first: migration 157's default privileges grant all four to
-- app_tenant, and GRANT is additive. Split policies then leave UPDATE and
-- DELETE with no permissive policy, so they stay denied even if a later
-- migration restores the table grant.

ALTER TABLE ai_ops_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_ops_events FROM anon, authenticated;
REVOKE ALL ON ai_ops_events FROM app_tenant;
GRANT SELECT, INSERT ON ai_ops_events TO app_tenant;
DROP POLICY IF EXISTS deny_all_direct_access ON ai_ops_events;
CREATE POLICY deny_all_direct_access ON ai_ops_events
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS ai_ops_events_tenant_select ON ai_ops_events;
DROP POLICY IF EXISTS ai_ops_events_tenant_insert ON ai_ops_events;
CREATE POLICY ai_ops_events_tenant_select ON ai_ops_events
  AS PERMISSIVE FOR SELECT TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true));
CREATE POLICY ai_ops_events_tenant_insert ON ai_ops_events
  AS PERMISSIVE FOR INSERT TO app_tenant
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
