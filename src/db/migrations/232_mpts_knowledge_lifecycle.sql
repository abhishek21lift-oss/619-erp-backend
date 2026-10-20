-- 232_mpts_knowledge_lifecycle.sql
-- MPTS-grounded AI: the shared (is_global) knowledge corpus becomes an
-- audited, versioned, approved source of truth for AI generation.
--
-- Adds, to the EXISTING ai_documents / retrieval stack (all additive):
--   * source_version  — the curator-declared version of a source document
--   * content_hash    — sha256 of the stored bytes, used for duplicate
--                       detection on the platform corpus (org uploads may
--                       leave it NULL; studio SOP flow is unchanged)
--   * approval_status — 'pending' | 'approved' | 'revoked'. REVIEW GATE:
--                       a document only becomes an active generation source
--                       when retrieval can see it AND it is approved.
--                       Default 'approved' keeps every pre-existing studio
--                       document working exactly as before (studio docs keep
--                       their own governance; only the platform corpus and
--                       new platform uploads carry the gate in practice).
--   * approved_by / approved_at — who activated a version and when.
--
-- Revocation semantics: revoking (or superseding) a document never deletes
-- chunks or files — the document simply stops being retrievable, so old
-- generated artifacts remain traceable to a source that existed, while new
-- generations cannot cite it.
--
-- Plus a new tenant-scoped retrieval ledger:
--   ai_retrieval_log — one row per retrieval attempt (generators + search),
--                      with the corpus version that was live at query time,
--                      so any generated artifact can be traced back to the
--                      exact approved corpus state it was grounded in.
--
-- Rollback (no data loss):
--   DROP TABLE IF EXISTS ai_retrieval_log;
--   ALTER TABLE ai_documents DROP COLUMN approval_status, DROP COLUMN source_version,
--     DROP COLUMN content_hash, DROP COLUMN approved_by, DROP COLUMN approved_at;

ALTER TABLE ai_documents
    ADD COLUMN IF NOT EXISTS source_version TEXT,
    ADD COLUMN IF NOT EXISTS content_hash TEXT,
    ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved'
        CHECK (approval_status IN ('pending', 'approved', 'revoked')),
    ADD COLUMN IF NOT EXISTS approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- Hot-path partial index: retrieval only ever reads approved rows.
CREATE INDEX IF NOT EXISTS idx_ai_documents_corpus
    ON ai_documents (approval_status)
    WHERE approval_status = 'approved' AND status = 'ready';

-- ── Retrieval ledger ─────────────────────────────────────────────────────────
-- organization_id is the CALLING studio (or NULL when the platform plane
-- itself queries); it is deliberately nullable for the platform case and as a
-- hard rule a tenant caller always has one (auth middleware refuses tenant
-- roles without an org).
CREATE TABLE IF NOT EXISTS ai_retrieval_log (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID        REFERENCES organizations(id) ON DELETE SET NULL,
    user_id          TEXT        REFERENCES users(id) ON DELETE SET NULL,
    route            TEXT        NOT NULL,
    result           TEXT        NOT NULL CHECK (result IN ('ok', 'empty', 'unavailable', 'stale', 'skipped')),
    document_ids     UUID[]      NOT NULL DEFAULT '{}',
    corpus_version   TEXT,
    top_k            INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_retrieval_log_org_time
    ON ai_retrieval_log (organization_id, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- House style from 104/116/131 (ai_documents/ai_document_chunks already carry
-- their deny-all policies): REVOKE the PostgREST roles outright, ENABLE RLS,
-- deny anon+authenticated by policy, and give the app's own tenant role the
-- standard org-scoped policy so the app_tenant cutover (TENANT-RLS-PLAN.md)
-- does not silently lose write access. The platform plane reaches it via the
-- owner connection.

REVOKE ALL ON public.ai_retrieval_log FROM anon, authenticated;

-- Tenant plane: scoped SELECT by the RLS policy, and INSERT kept for the
-- app_tenant-connection cutover. UPDATE and DELETE are deliberately not
-- granted — the ledger is an append-only audit trail; even a tenant-matching
-- session must never be able to rewrite or erase retrieval history.
GRANT SELECT, INSERT ON public.ai_retrieval_log TO app_tenant;

ALTER TABLE public.ai_retrieval_log
    ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_direct_access ON public.ai_retrieval_log;
CREATE POLICY deny_all_direct_access ON public.ai_retrieval_log
    AS PERMISSIVE FOR ALL TO anon, authenticated
    USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS ai_retrieval_log_tenant ON public.ai_retrieval_log;
CREATE POLICY ai_retrieval_log_tenant ON public.ai_retrieval_log
    AS PERMISSIVE FOR ALL TO app_tenant
    USING (organization_id::text = current_setting('app.org_id', true))
    WITH CHECK (organization_id::text = current_setting('app.org_id', true));
