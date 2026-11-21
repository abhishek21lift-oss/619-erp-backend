-- 286_ai_knowledge_global_rls.sql
-- Make the approved GLOBAL knowledge corpus readable by a tenant connection —
-- and only readable — once `DATABASE_URL` moves to `app_tenant`.
--
-- ── The gap this closes ────────────────────────────────────────────────────
--
-- 157 created `tenant_isolation` on every table carrying organization_id:
--
--   USING (organization_id::text = current_setting('app.org_id', true))
--
-- 173 then introduced platform-wide documents as `organization_id IS NULL,
-- is_global = TRUE` and dropped NOT NULL on both ai_documents and
-- ai_document_chunks. The policy was never widened, so RLS removes a global
-- document before retrieval's own predicate
--
--   (d.is_global = TRUE OR d.organization_id = $2)
--
-- can ever see it. Until DATABASE_URL moves to app_tenant the owner role
-- bypasses RLS and nothing is observable. On the cutover day every studio
-- silently loses the global corpus, and the grounded generators answer
-- 422 INSUFFICIENT_EVIDENCE even though the documents are approved and ready.
--
-- ── The shape, and why it is split by command ──────────────────────────────
--
-- A single FOR ALL policy cannot express "read the global corpus, but never
-- write it": its USING clause also governs UPDATE and DELETE, so a tenant that
-- can read a global row could try to adopt it by rewriting organization_id.
-- The policies are therefore split, following 277's pattern:
--
--   SELECT  own organization OR a global document, and only while app.org_id
--           is set. An org-less app_tenant session stays fail-closed, which
--           is the property 157 was built around.
--   INSERT  own organization, is_global = FALSE.
--   UPDATE  own organization, is_global = FALSE, in USING and WITH CHECK.
--   DELETE  own organization, is_global = FALSE.
--
-- Chunks authorize through their parent document, the same document-level
-- rule retrieval uses. Their write policies also require the parent to be the
-- caller's own non-global document. Without that, a tenant connection could
-- insert a chunk pointing at a global document and inject content into every
-- studio's corpus, because retrieval filters the parent, not the chunk.
--
-- ── Idempotent, forward-only ───────────────────────────────────────────────
--
-- Drops 157's tenant_isolation on these two tables and this migration's own
-- policy names. No rows are read, written or deleted. migrate.js owns the
-- transaction.

DROP POLICY IF EXISTS tenant_isolation ON public.ai_documents;
DROP POLICY IF EXISTS ai_documents_tenant_select ON public.ai_documents;
DROP POLICY IF EXISTS ai_documents_tenant_insert ON public.ai_documents;
DROP POLICY IF EXISTS ai_documents_tenant_update ON public.ai_documents;
DROP POLICY IF EXISTS ai_documents_tenant_delete ON public.ai_documents;

CREATE POLICY ai_documents_tenant_select ON public.ai_documents
    AS PERMISSIVE FOR SELECT TO app_tenant
    USING (
        organization_id::text = current_setting('app.org_id', true)
        OR (
            is_global = TRUE
            AND NULLIF(current_setting('app.org_id', true), '') IS NOT NULL
        )
    );

CREATE POLICY ai_documents_tenant_insert ON public.ai_documents
    AS PERMISSIVE FOR INSERT TO app_tenant
    WITH CHECK (
        organization_id::text = current_setting('app.org_id', true)
        AND is_global = FALSE
    );

CREATE POLICY ai_documents_tenant_update ON public.ai_documents
    AS PERMISSIVE FOR UPDATE TO app_tenant
    USING (
        organization_id::text = current_setting('app.org_id', true)
        AND is_global = FALSE
    )
    WITH CHECK (
        organization_id::text = current_setting('app.org_id', true)
        AND is_global = FALSE
    );

CREATE POLICY ai_documents_tenant_delete ON public.ai_documents
    AS PERMISSIVE FOR DELETE TO app_tenant
    USING (
        organization_id::text = current_setting('app.org_id', true)
        AND is_global = FALSE
    );

DROP POLICY IF EXISTS tenant_isolation ON public.ai_document_chunks;
DROP POLICY IF EXISTS ai_document_chunks_tenant_select ON public.ai_document_chunks;
DROP POLICY IF EXISTS ai_document_chunks_tenant_insert ON public.ai_document_chunks;
DROP POLICY IF EXISTS ai_document_chunks_tenant_update ON public.ai_document_chunks;
DROP POLICY IF EXISTS ai_document_chunks_tenant_delete ON public.ai_document_chunks;

CREATE POLICY ai_document_chunks_tenant_select ON public.ai_document_chunks
    AS PERMISSIVE FOR SELECT TO app_tenant
    USING (
        EXISTS (
            SELECT 1
              FROM public.ai_documents d
             WHERE d.id = ai_document_chunks.document_id
               AND (
                   d.organization_id::text = current_setting('app.org_id', true)
                   OR (
                       d.is_global = TRUE
                       AND NULLIF(current_setting('app.org_id', true), '') IS NOT NULL
                   )
               )
        )
    );

CREATE POLICY ai_document_chunks_tenant_insert ON public.ai_document_chunks
    AS PERMISSIVE FOR INSERT TO app_tenant
    WITH CHECK (
        organization_id::text = current_setting('app.org_id', true)
        AND EXISTS (
            SELECT 1
              FROM public.ai_documents d
             WHERE d.id = ai_document_chunks.document_id
               AND d.organization_id::text = current_setting('app.org_id', true)
               AND d.is_global = FALSE
        )
    );

CREATE POLICY ai_document_chunks_tenant_update ON public.ai_document_chunks
    AS PERMISSIVE FOR UPDATE TO app_tenant
    USING (
        organization_id::text = current_setting('app.org_id', true)
        AND EXISTS (
            SELECT 1
              FROM public.ai_documents d
             WHERE d.id = ai_document_chunks.document_id
               AND d.organization_id::text = current_setting('app.org_id', true)
               AND d.is_global = FALSE
        )
    )
    WITH CHECK (
        organization_id::text = current_setting('app.org_id', true)
        AND EXISTS (
            SELECT 1
              FROM public.ai_documents d
             WHERE d.id = ai_document_chunks.document_id
               AND d.organization_id::text = current_setting('app.org_id', true)
               AND d.is_global = FALSE
        )
    );

CREATE POLICY ai_document_chunks_tenant_delete ON public.ai_document_chunks
    AS PERMISSIVE FOR DELETE TO app_tenant
    USING (
        organization_id::text = current_setting('app.org_id', true)
        AND EXISTS (
            SELECT 1
              FROM public.ai_documents d
             WHERE d.id = ai_document_chunks.document_id
               AND d.organization_id::text = current_setting('app.org_id', true)
               AND d.is_global = FALSE
        )
    );

-- 157 already granted these four on every table that existed then. Re-stating
-- them keeps the cutover working if a future default-privilege change (the
-- shape 277 had to repair) ever removes them. Nothing is widened: the
-- policies above decide which rows each command may touch.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_documents TO app_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_document_chunks TO app_tenant;
