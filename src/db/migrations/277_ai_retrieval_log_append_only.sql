-- 277_ai_retrieval_log_append_only.sql
-- Make the AI retrieval ledger append-only at the privilege AND policy layer.
--
-- ── The gap this closes ────────────────────────────────────────────────────
--
-- 232_mpts_knowledge_lifecycle.sql created public.ai_retrieval_log and ended
-- with an explicit `GRANT SELECT, INSERT ... TO app_tenant`. That looked
-- append-only, but 157_APP_TENANT_ROLE_AND_RLS.sql set:
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant;
--
-- GRANT is additive, so the explicit two-privilege grant removed nothing: the
-- table inherited all four privileges, and the ai_retrieval_log_tenant policy
-- was FOR ALL. A tenant-scoped connection could rewrite or erase its own
-- retrieval audit trail. See
-- docs/ai-copilot/AI_RETRIEVAL_LOG_APPEND_ONLY_FINDING.md.
--
-- ── What changes, and what does not ────────────────────────────────────────
--
-- No rows are read, written or deleted. The owner connection keeps full DML by
-- design. The deny-all policy for anon/authenticated is untouched. Tenant
-- reads and inserts keep the exact org predicate they had; only UPDATE and
-- DELETE are removed, at both layers:
--
--   1. Table privileges: revoke everything, then grant back SELECT and INSERT
--      only. REVOKE ALL (not just UPDATE/DELETE) also removes a stray
--      TRUNCATE/REFERENCES/TRIGGER grant if one ever appears.
--   2. Policy shape: replace the FOR ALL tenant policy with SELECT and INSERT
--      policies. UPDATE and DELETE then have no permissive policy, so they
--      stay denied even if a later migration accidentally restores the table
--      grant.
--
-- Do not broaden this into a bulk privilege rewrite; every append-only table
-- needs its own review. This file touches only ai_retrieval_log.

REVOKE ALL ON public.ai_retrieval_log FROM app_tenant;
GRANT SELECT, INSERT ON public.ai_retrieval_log TO app_tenant;

DROP POLICY IF EXISTS ai_retrieval_log_tenant ON public.ai_retrieval_log;
DROP POLICY IF EXISTS ai_retrieval_log_tenant_select ON public.ai_retrieval_log;
DROP POLICY IF EXISTS ai_retrieval_log_tenant_insert ON public.ai_retrieval_log;

CREATE POLICY ai_retrieval_log_tenant_select ON public.ai_retrieval_log
    AS PERMISSIVE FOR SELECT TO app_tenant
    USING (organization_id::text = current_setting('app.org_id', true));

CREATE POLICY ai_retrieval_log_tenant_insert ON public.ai_retrieval_log
    AS PERMISSIVE FOR INSERT TO app_tenant
    WITH CHECK (organization_id::text = current_setting('app.org_id', true));
