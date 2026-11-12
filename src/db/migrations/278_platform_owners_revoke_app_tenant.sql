-- 278_platform_owners_revoke_app_tenant.sql
-- Re-assert the deny-all ACL that 161 intended for platform_owners.
--
-- 161 creates the table, enables + forces RLS with no policies, and revokes
-- app_tenant. The restored production baseline still shows
-- app_tenant=arwd/postgres on the table, and rls.isolation.integration.test.js
-- expects no privileges. The grants do not disclose rows today — with RLS
-- forced and no permissive policy, SELECT returns 0 and INSERT is refused —
-- but app_tenant has no reason to hold them: the platform console reads this
-- table over the owner connection, and no tenant-facing code writes it.
--
-- The grant likely survives because 157 set the schema-wide default
-- privileges before 161 created the table, so CREATE TABLE inherited
-- SELECT/INSERT/UPDATE/DELETE at creation. This migration is the per-table
-- correction. It changes no rows, policies or role attributes.
--
-- Idempotent: REVOKE on an absent privilege is a no-op. Forward-only: there
-- is no down migration, because re-granting would undo the hardening.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE 'REVOKE ALL ON public.platform_owners FROM app_tenant';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.platform_owners FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.platform_owners FROM authenticated';
  END IF;
END $$;
