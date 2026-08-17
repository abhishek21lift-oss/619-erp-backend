-- 173_ai_knowledge_global_documents.sql
-- Global 619 Fitness knowledge: knowledge-base documents that are explicitly
-- marked as globally available to every organization, alongside each
-- organization's own private documents.
--
-- Tenant isolation model:
--   * ai_documents.organization_id NOT NULL  -> a studio's private knowledge
--   * ai_documents.organization_id NULL + is_global = TRUE -> platform-wide
--     619 Fitness knowledge (uploaded by a platform super admin only)
--   * is_global = TRUE implies organization_id IS NULL (a document is either
--     one studio's private knowledge or explicit global knowledge — never both,
--     so there is no ambiguity about which tenant filter applies).
--
-- Retrieval (lib/ai/knowledgeBase.js) filters at the DOCUMENT level:
--     WHERE d.status = 'ready'
--       AND (d.is_global = TRUE OR d.organization_id = $2)
--   which is strictly safer than filtering on the denormalized chunk row:
--   a chunk is reachable only through its parent document, and the document's
--   tenancy is the single source of truth.

ALTER TABLE ai_documents
    ADD COLUMN IF NOT EXISTS is_global BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ai_documents
    ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE ai_document_chunks
    ALTER COLUMN organization_id DROP NOT NULL;

-- Every non-global document must still belong to an organization (matches the
-- pre-existing NOT NULL semantics for studio-private documents).
ALTER TABLE ai_documents
    DROP CONSTRAINT IF EXISTS ai_documents_global_org_check;

ALTER TABLE ai_documents
    ADD CONSTRAINT ai_documents_global_org_check
    CHECK (is_global = TRUE OR organization_id IS NOT NULL);

-- Fast path for the retrieval filter's global branch. Studio-private
-- documents are already indexed by organization_id (migration 135).
CREATE INDEX IF NOT EXISTS idx_ai_documents_global
    ON ai_documents (is_global)
    WHERE is_global = TRUE;
