-- ============================================================
-- 180_ai_audit_tracking.sql
--
-- P0-10 — AI auditability (privacy-safe audit metadata).
--
-- ai_usage_log already records who, what, when, how much:
--   user_id, conversation_id, model, provider, intent_type,
--   tokens_*, latency_ms, used_fallback (migrations 024/029/042/043).
-- What it CANNOT answer today is the safety story of each request:
-- was a chat message flagged high-risk or medical? Was input
-- moderation applied and what tier did it land on? Did RAG ground
-- the answer? Which studio does the usage belong to (today that is
-- derived by joining through users)? And which error, if any, ended
-- the request?
--
-- This migration adds ONLY metadata for those questions. Per the
-- audit-log privacy rule it stores never the prompt, never the
-- response, never medical notes/history, never retrieved document
-- contents, never full client profiles, never secrets or tokens.
-- Every new column is a label or a count — an organization, a
-- request correlation id, a client id, a model tier, a safety
-- category, a moderation tier, a boolean, an error code.
--
-- All columns are nullable and additive (ADD COLUMN IF NOT EXISTS),
-- so existing rows and the existing insert path are untouched; a
-- request that was never checked for safety/moderation (or never
-- reached RAG) simply leaves those columns NULL.
-- ============================================================

ALTER TABLE public.ai_usage_log
  ADD COLUMN IF NOT EXISTS organization_id      UUID REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS request_id           TEXT,
  ADD COLUMN IF NOT EXISTS client_id            TEXT,
  ADD COLUMN IF NOT EXISTS tier                 TEXT,
  ADD COLUMN IF NOT EXISTS safety_outcome       TEXT,
  ADD COLUMN IF NOT EXISTS moderation_outcome   TEXT,
  ADD COLUMN IF NOT EXISTS rag_used             BOOLEAN,
  ADD COLUMN IF NOT EXISTS error_code           TEXT;

-- Lookups the audit/reporting queries will actually run: per-studio
-- usage over time (organization_id + created_at, same shape as
-- aiQuota's join-through-users query but without the join) and
-- request-id correlation (a single request that produced both a
-- refused 403 AND a usage row, or that an operator needs to find
-- from a client-reported id). Both partial so a NULL never occupies
-- index space — the common case for these two columns is NULL.
CREATE INDEX IF NOT EXISTS ai_usage_org_idx
  ON ai_usage_log (organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_usage_request_idx
  ON ai_usage_log (request_id)
  WHERE request_id IS NOT NULL;

COMMENT ON COLUMN public.ai_usage_log.organization_id IS
  'Audit metadata — the studio the request ran for (NULL for platform-wide super-admin work). Added by 180; historical rows keep NULL and still join through users.';
COMMENT ON COLUMN public.ai_usage_log.request_id IS
  'Audit metadata — the x-request-id correlation id from middleware/requestId (req.id). Lets a refused 403 and the successful log row be linked.';
COMMENT ON COLUMN public.ai_usage_log.client_id IS
  'Audit metadata — the client id the request concerned (chat/plan generators). Never the profile itself.';
COMMENT ON COLUMN public.ai_usage_log.tier IS
  'Audit metadata — model tier actually used (primary/secondary/fallback), matching lib/ai/models resolveModel tiers.';
COMMENT ON COLUMN public.ai_usage_log.safety_outcome IS
  'Audit metadata — chat-safety classification (high_risk|medical|fitness) when the request ran one; NULL otherwise. Not the message.';
COMMENT ON COLUMN public.ai_usage_log.moderation_outcome IS
  'Audit metadata — input-moderation tier (HIGH_RISK|BLOCK|SUSPICIOUS|SAFE) when the request ran one; NULL otherwise. Not the message.';
COMMENT ON COLUMN public.ai_usage_log.rag_used IS
  'Audit metadata — true when authorized knowledge-base retrieval supplied context to the model.';
COMMENT ON COLUMN public.ai_usage_log.error_code IS
  'Audit metadata — machine error code when the request did not complete (e.g. SAFETY_HIGH_RISK, MODERATION_BLOCKED); NULL on success.';
