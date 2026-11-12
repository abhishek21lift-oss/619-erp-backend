-- 273_ai_copilot_context_tenancy.sql
-- M1 — conversation tenancy, archive and per-thread context.
--
-- ── Verified before writing (2026-11-11, project 619-erp) ──────────────────
--
--   ai_conversations   93 rows
--   columns            id, user_id, title, client_id, created_at, updated_at, pinned
--   organization_id    absent
--   RLS                enabled; tenant_isolation reaches the org through
--                      users.organization_id, deny_all_direct_access present
--
-- The table is small (93 rows), so the ACCESS EXCLUSIVE lock taken by ADD
-- COLUMN and the short UPDATE is measured in milliseconds. No CONCURRENTLY is
-- possible inside the runner's transaction, and none is needed at this size.
--
-- ── Why these columns ──────────────────────────────────────────────────────
--
-- organization_id  today every tenant predicate on a conversation is a join
--                  through users. Stamping the org makes "delete this studio's
--                  threads", "does this thread belong here" and future
--                  org-level retention a single indexed predicate.
-- archived_at      archive is not delete: a trainer can clear the rail without
--                  losing the audit trail. NULL means active.
-- context          the per-thread context selection (client id, policy at the
--                  time, pinned sources), so reopening a thread restores what
--                  the answer was written against. An object, never prompt text.
--
-- ── Backfill ───────────────────────────────────────────────────────────────
--
-- Set-based from the owning user. Idempotent (only NULL rows), and a user with
-- no organization leaves the column NULL — those rows are never returned to a
-- tenant caller, which is the fail-closed half of the tenant rule.
--
-- ── Rollback (forward-only runner; run manually only if M1 must be undone) ─
--
--   DROP INDEX IF EXISTS ai_conversations_org_user_updated_idx;
--   ALTER TABLE ai_conversations
--     DROP COLUMN IF EXISTS context,
--     DROP COLUMN IF EXISTS archived_at,
--     DROP COLUMN IF EXISTS organization_id;
--
-- Dropping the columns discards archive/context state written after deploy;
-- no pre-existing data is affected.

ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS context JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE ai_conversations c
   SET organization_id = u.organization_id
  FROM users u
 WHERE c.user_id = u.id
   AND c.organization_id IS NULL
   AND u.organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_conversations_org_user_updated_idx
  ON ai_conversations (organization_id, user_id, updated_at DESC);
