-- 283_rls_gate_hardening.sql
-- Make the two tenant-plane gates from the app_tenant cutover durable.
--
-- The cutover runbook (docs/APP_TENANT_CUTOVER_RUNBOOK.md, gates G2 and G3) had
-- both applied out-of-band on 2026-11-13, so production is already in the
-- target state. They were not in the ledger, which means a restore of an older
-- dump — or a future migration that recreates the policy — silently undoes
-- them. This file records the same two changes in the migration history, so a
-- fresh install and a restored dump both end up where production is.
--
-- G2. pt_posture_assessments_pre_268_backup is a pre-268 copy of the posture
--     assessments table: real tenant data, RLS disabled, and app_tenant held
--     full DML on it. It was the one table a tenant connection could read
--     across studios once DATABASE_URL points at app_tenant. Moving it to
--     purge_backup takes it out of reach: app_tenant has no USAGE on that
--     schema (verified in production, 2026-11-13). No backend code references
--     the table (grep, 2026-11-13). The rows are preserved — this moves nothing
--     out of the database, it only changes the schema it lives in. Drop the
--     table after 30 days if nothing asks for it.
--
-- G3. audit_log carried tenant_shared_read FOR ALL TO app_tenant USING (true)
--     plus full DML — a platform-plane table any tenant connection could read
--     and write. The table is empty and no backend code reads or writes it (the
--     super-admin audit UI uses activity_log). Dropping the policy and
--     revoking DML leaves SELECT, which RLS answers with zero rows because no
--     tenant policy remains.
--
-- Idempotent, and a no-op where the gates are already applied: the move only
-- runs while the table is still in public, indexes follow the table, and every
-- other statement is guarded. Forward-only: no down migration, because
-- re-granting would undo the hardening. Rollback SQL, if a human needs it, is
-- in the runbook.
DO $$
BEGIN
  -- G2 ---------------------------------------------------------------------
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'pt_posture_assessments_pre_268_backup'
       AND c.relkind = 'r'
  ) THEN
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS purge_backup';
    EXECUTE 'ALTER TABLE public.pt_posture_assessments_pre_268_backup SET SCHEMA purge_backup';
  END IF;

  -- Re-assert the mechanism G2 depends on, even when the move was already done.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'purge_backup')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA purge_backup FROM app_tenant';
  END IF;

  -- G3 ---------------------------------------------------------------------
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS tenant_shared_read ON public.audit_log';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
      EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_log FROM app_tenant';
    END IF;
  END IF;
END $$;
