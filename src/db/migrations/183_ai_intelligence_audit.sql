-- ============================================================
-- 183_ai_intelligence_audit.sql
--
-- Phase 2F — Trainer Intelligence audit trail.
--
-- Records every approval/rejection/confirmation action with
-- full provenance: who, what, when, previous state, new state.
--
-- PRIVACY:
--   - No AI prompts or responses stored
--   - No client PII beyond IDs
--   - Only action metadata
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_intelligence_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id        TEXT NOT NULL,
  target_type     TEXT NOT NULL CHECK (target_type IN ('memory', 'proposal')),
  target_id       UUID NOT NULL,
  action          TEXT NOT NULL CHECK (action IN (
                    'confirm', 'reject', 'approve', 'reject_proposal',
                    'supersede', 'expire', 'execute'
                  )),
  previous_state  TEXT,
  new_state       TEXT,
  reason          TEXT,
  request_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup: audit history for a target
CREATE INDEX IF NOT EXISTS idx_ai_intelligence_audit_target
  ON ai_intelligence_audit (target_type, target_id, created_at DESC);

-- Fast lookup: audit history for an actor
CREATE INDEX IF NOT EXISTS idx_ai_intelligence_audit_actor
  ON ai_intelligence_audit (actor_id, organization_id, created_at DESC);

-- Fast lookup: audit history for an organization
CREATE INDEX IF NOT EXISTS idx_ai_intelligence_audit_org
  ON ai_intelligence_audit (organization_id, created_at DESC);

COMMENT ON TABLE  public.ai_intelligence_audit IS
  'Phase 2F — Audit trail for trainer intelligence actions (memory confirm/reject, proposal approve/reject). No AI prompts/responses stored.';
COMMENT ON COLUMN public.ai_intelligence_audit.target_type IS
  'What was acted upon: memory or proposal.';
COMMENT ON COLUMN public.ai_intelligence_audit.action IS
  'What was done: confirm, reject, approve, reject_proposal, supersede, expire, execute.';
