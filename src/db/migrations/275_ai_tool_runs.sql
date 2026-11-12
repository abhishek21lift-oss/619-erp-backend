-- 275_ai_tool_runs.sql
-- M3 — durable, tenant-scoped AI tool execution ledger.
--
-- ── Dependency and apply order ─────────────────────────────────────────────
--
-- 273 (M1: conversation organization_id + archive) → 274 (M2: message meta) →
-- this file. The ownership subqueries below reference
-- ai_conversations.organization_id, so M1 must already be applied. migrate.js
-- sorts filenames and wraps each file in its own transaction, so the numeric
-- order is the apply order.
--
-- ── What this table is, and is not ─────────────────────────────────────────
--
-- One row per attempted Copilot tool execution: successful, denied, failed or
-- timed out. It is an audit ledger, not a result cache. It stores:
--
--   * identifiers (organization, user, conversation, message, correlation);
--   * the tool name, level, sensitivity and a hash of its arguments;
--   * bounded scalar argument metadata (dates, limits, windows), never free
--     text or client records;
--   * status, exact error code and one stable error category;
--   * the planner's short selection reason (why this tool was chosen);
--   * source module, source record ids, source as-of and freshness flags;
--   * bounded result metadata (record count, missing markers, stale flag);
--   * execution duration and creation time.
--
-- It does NOT store prompts, message bodies, tokens, secrets, contact details,
-- clinical notes or raw tool payloads. result_meta is a summary, not data.
--
-- ── Tenancy ────────────────────────────────────────────────────────────────
--
-- organization_id is stamped from the authenticated user row, never from a
-- request body. The insert resolves conversation_id and message_id through
-- subqueries that require the same user and organization; a foreign id is
-- stored as NULL rather than linked. Read APIs filter on organization_id AND
-- user_id, so a foreign run is indistinguishable from an unknown one.
--
-- organization_id is nullable only for a denial that happened before a tenant
-- could be resolved (NO_TENANT / UNAUTHENTICATED). Those rows are never
-- returned by a tenant-scoped API and are hidden by the app_tenant RLS policy.
--
-- ── Retention and deletion ─────────────────────────────────────────────────
--
--   conversation deleted  → conversation_id/message_id SET NULL (ledger stays)
--   message deleted       → message_id SET NULL
--   user deleted          → user_id SET NULL (org audit stays)
--   organization deleted  → row cascades with the tenant
--
-- There is no automatic ledger sweep in Phase 4. The conversation retention
-- job (lib/ai/retention.js) removes threads after its configured window; the
-- ledger deliberately survives that deletion because it is the audit trail.
-- A future retention window for ai_tool_runs needs its own approved decision.
--
-- ── Indexes, locks and backfill ────────────────────────────────────────────
--
-- This is a new, empty table: CREATE INDEX inside the runner's transaction does
-- not block existing writes and needs no CONCURRENTLY. No backfill is possible
-- or attempted — the ledger starts empty at deploy, and pre-Phase-4 tool calls
-- were never recorded durably.
--
-- ── Rollback (forward-only runner; manual only) ────────────────────────────
--
--   DROP TABLE IF EXISTS ai_tool_runs;
--
-- Irreversibly discards the entire audit history. Prefer a forward migration.
-- Dropping the table does not affect conversations, messages or their meta.

CREATE TABLE IF NOT EXISTS ai_tool_runs (
  id                TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  organization_id   UUID        REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           TEXT        REFERENCES users(id) ON DELETE SET NULL,
  conversation_id   TEXT        REFERENCES ai_conversations(id) ON DELETE SET NULL,
  message_id        TEXT        REFERENCES ai_messages(id) ON DELETE SET NULL,
  correlation_id    TEXT        NOT NULL,
  run_key           TEXT        NOT NULL UNIQUE,
  tool_name         TEXT        NOT NULL,
  level             TEXT        CHECK (level IS NULL OR level IN ('READ','ANALYZE','DRAFT','EXECUTE')),
  sensitivity       TEXT        CHECK (sensitivity IS NULL OR sensitivity IN ('public','business','schedule','personal','clinical')),
  client_id         TEXT        REFERENCES pt_clients(id) ON DELETE SET NULL,
  args_digest       TEXT        NOT NULL,
  args_meta         JSONB       CHECK (args_meta IS NULL OR jsonb_typeof(args_meta) = 'object'),
  status            TEXT        NOT NULL CHECK (status IN ('ok','denied','failed','timeout')),
  error_code        TEXT,
  error_category    TEXT        CHECK (error_category IS NULL OR error_category IN (
                      'NO_TOOL_MATCH',
                      'AUTHORIZATION_DENIED',
                      'TENANT_SCOPE_DENIED',
                      'CLIENT_SCOPE_DENIED',
                      'ARGUMENT_VALIDATION_FAILED',
                      'TOOL_EXECUTION_FAILED',
                      'TOOL_TIMEOUT'
                    )),
  source            TEXT,
  source_refs       JSONB       NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(source_refs) = 'array'),
  source_as_of      TIMESTAMPTZ,
  freshness         JSONB       CHECK (freshness IS NULL OR jsonb_typeof(freshness) = 'object'),
  result_meta       JSONB       CHECK (result_meta IS NULL OR jsonb_typeof(result_meta) = 'object'),
  duration_ms       INTEGER     NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  selection_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_tool_runs_status_fields CHECK (
    (status = 'ok' AND error_code IS NULL AND error_category IS NULL)
    OR (status <> 'ok' AND error_category IS NOT NULL)
  ),
  CONSTRAINT ai_tool_runs_org_scope CHECK (
    organization_id IS NOT NULL
    OR (status = 'denied' AND error_category IN ('AUTHORIZATION_DENIED','TENANT_SCOPE_DENIED'))
  )
);

CREATE INDEX IF NOT EXISTS ai_tool_runs_org_conv_created_idx
  ON ai_tool_runs (organization_id, conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ai_tool_runs_org_user_created_idx
  ON ai_tool_runs (organization_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ai_tool_runs_correlation_idx
  ON ai_tool_runs (correlation_id);

COMMENT ON TABLE ai_tool_runs IS
  'Append-only Copilot tool execution ledger (migration 275). Identifiers, sanitized metadata and provenance only; no prompts, payloads, contact data or clinical text.';

-- RLS and grants: tenants may append and read their own rows, never update or
-- delete them. The explicit REVOKE is load-bearing: 157's ALTER DEFAULT
-- PRIVILEGES grants SELECT, INSERT, UPDATE and DELETE on every new public
-- table, and GRANT is additive, so GRANT SELECT, INSERT alone would leave
-- UPDATE and DELETE in place. The owner connection retains full access for
-- retention and platform operations.
REVOKE ALL ON public.ai_tool_runs FROM anon, authenticated;
GRANT SELECT, INSERT ON public.ai_tool_runs TO app_tenant;
REVOKE UPDATE, DELETE ON public.ai_tool_runs FROM app_tenant;

ALTER TABLE public.ai_tool_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deny_all_direct_access ON public.ai_tool_runs;
CREATE POLICY deny_all_direct_access ON public.ai_tool_runs
    AS PERMISSIVE FOR ALL TO anon, authenticated
    USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS ai_tool_runs_tenant ON public.ai_tool_runs;
CREATE POLICY ai_tool_runs_tenant ON public.ai_tool_runs
    AS PERMISSIVE FOR ALL TO app_tenant
    USING (organization_id::text = current_setting('app.org_id', true))
    WITH CHECK (organization_id::text = current_setting('app.org_id', true));
