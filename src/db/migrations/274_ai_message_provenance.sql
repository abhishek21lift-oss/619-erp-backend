-- 274_ai_message_provenance.sql
-- M2 — message-level provenance for Copilot answers.
--
-- ── Dependency ─────────────────────────────────────────────────────────────
--
-- 273 (M1) must already be applied: it adds ai_conversations.organization_id
-- and archived_at. This migration deliberately does NOT copy organization_id
-- onto ai_messages. A message has exactly one parent conversation; duplicating
-- the tenant on the child would create two sources of truth that can drift.
-- Tenant predicates join ai_conversations.organization_id, which is indexed by
-- 273, and the existing ai_messages RLS policy already reaches the org through
-- conversation_id.
--
-- Archive support is already owned by M1 (archived_at). No second archive
-- column is added here, and there is no product requirement for a separate
-- message-level archive.
--
-- ── Shape ──────────────────────────────────────────────────────────────────
--
-- routes/ai.js writes an object of references only:
--
--   { correlation_id, intent, model, grounding,
--     tools:  [{ tool, run_id, ok, code }],
--     sources: ["document title"],
--     client_id }
--
-- No prompt text, message body, tool payload, contact data or clinical text.
-- The durable per-tool detail lives in ai_tool_runs (M3); this column is the
-- conversation-level summary that makes a thread reconstructable in one read.
--
-- ── Lock and index impact ──────────────────────────────────────────────────
--
-- ADD COLUMN with a constant default is a catalogue-only change on
-- PostgreSQL 11+; the table is not rewritten. No new index is needed: history
-- is already served by ai_messages_conv_idx (conversation_id, created_at ASC).
-- The migration runner wraps this file in a transaction, so no CONCURRENTLY is
-- possible or needed here.
--
-- ── Rollback (forward-only runner; manual only) ────────────────────────────
--
--   ALTER TABLE ai_messages DROP COLUMN IF EXISTS meta;
--
-- Discards provenance summaries written after deploy. The durable detail in
-- ai_tool_runs (M3) is not affected by this rollback.

ALTER TABLE ai_messages
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN ai_messages.meta IS
  'Copilot provenance summary (migration 274): tool run ids, source titles, grounding, model, intent. References and labels only — never prompt text or raw tool payloads.';
