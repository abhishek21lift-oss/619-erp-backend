-- Phase 6 production audit — read-only role.
-- Run as a database owner against the production database.
-- Nothing here writes data, alters a table, or grants anything beyond SELECT.
--
-- Replace <db> and <generated-secret> before running. Keep the password out of
-- shell history: pass it through the environment when invoking the audit.
--
-- Revoke with the final statement once the artifacts are collected.

BEGIN;

-- BYPASSRLS is required, not a convenience. Every clinical table has RLS
-- enabled, and a role without it reads zero rows instead of all rows: no
-- error, no warning, just a zero-count report whose schema gate then reads
-- ELIGIBLE_FOR_REVIEW. The role still has SELECT as its only data privilege,
-- and its sessions are forced read-only below. The audit wrapper refuses to
-- run if this attribute is missing.
CREATE ROLE myptstudio_audit LOGIN PASSWORD '<generated-secret>' BYPASSRLS;
ALTER ROLE myptstudio_audit SET default_transaction_read_only = on;

GRANT CONNECT ON DATABASE <db> TO myptstudio_audit;
GRANT USAGE ON SCHEMA public TO myptstudio_audit;

-- Exactly the tables the two analyzers read. No ALL TABLES shortcut: a new
-- table must be added here deliberately, which is also a review point.
GRANT SELECT ON
  pt_clients,
  pt_assessments,
  pt_goals,
  weekly_checkins,
  pt_lifestyle_assessments,
  pt_nutrition_assessments,
  pt_parq_forms,
  pt_client_interviews,
  pt_consent_records,
  pt_informed_consents,
  pt_mobility_performance_assessments,
  strength_logs,
  pt_os_measurements,
  client_fitness_profiles
TO myptstudio_audit;

COMMIT;

-- Verification: this must return exactly 14 rows, all with SELECT only.
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'myptstudio_audit'
ORDER BY table_name;

-- Revoke after the run:
--   DROP OWNED BY myptstudio_audit;
--   DROP ROLE myptstudio_audit;
