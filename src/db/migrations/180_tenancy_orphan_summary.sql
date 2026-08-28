-- ============================================================
-- 180_tenancy_orphan_summary.sql
--
-- The Command Centre's Tenancy Health card needs a single
-- number per tenant business table: how many rows have a NULL
-- organization_id. That number is the count of rows that would
-- slip past tenantScope() and RLS — orphans, by the codebase's
-- own definition.
--
-- The list of tables here is the same list that migration 174
-- brought into scope, plus a handful of newer tables that this
-- view also needs to know about. Adding a new tenant business
-- table to the platform means adding it here too — but unlike
-- KNOWN_GAPS (which is a list of debt), this list is a list of
-- tables that have organization_id, so the right thing when
-- adding a new table is to put it on the OTHER list (KNOWN_GAPS
-- in the convention test) until it is migrated, and only then
-- add it to this view.
--
-- The view is MATERIALIZED so the Tenancy Health card can read
-- it cheaply, including during an incident when the underlying
-- tables are under load. The refresh is a single statement and
-- runs against an aggregated view, not the raw tables.
--
-- Refresh cadence is driven by the application (every 5 min
-- from the tenancy-health endpoint when stale), not by pg_cron,
-- so a deployment that disables pg_cron does not break this.
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.tenancy_orphan_summary AS
SELECT 'users'::text                              AS table_name,
       COUNT(*) FILTER (WHERE organization_id IS NULL)::bigint AS null_org_count
  FROM public.users
UNION ALL
SELECT 'trainers'::text,
       COUNT(*) FILTER (WHERE organization_id IS NULL)::bigint
  FROM public.trainers
UNION ALL
SELECT 'pt_clients'::text,
       COUNT(*) FILTER (WHERE organization_id IS NULL)::bigint
  FROM public.pt_clients
UNION ALL
SELECT 'pt_payments'::text,
       COUNT(*) FILTER (WHERE organization_id IS NULL)::bigint
  FROM public.pt_payments
UNION ALL
SELECT 'subscription_invoices'::text,
       COUNT(*) FILTER (WHERE organization_id IS NULL)::bigint
  FROM public.subscription_invoices
UNION ALL
SELECT 'pt_lifestyle_assessments'::text,
       COUNT(*) FILTER (WHERE organization_id IS NULL)::bigint
  FROM public.pt_lifestyle_assessments
UNION ALL
SELECT 'pt_nutrition_assessments'::text,
       COUNT(*) FILTER (WHERE organization_id IS NULL)::bigint
  FROM public.pt_nutrition_assessments
UNION ALL
SELECT 'session_balance'::text,
       COUNT(*) FILTER (WHERE organization_id IS NULL)::bigint
  FROM public.session_balance
UNION ALL
SELECT 'communication_logs'::text,
       COUNT(*) FILTER (WHERE organization_id IS NULL)::bigint
  FROM public.communication_logs;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenancy_orphan_summary_table
  ON public.tenancy_orphan_summary (table_name);

-- The view holds aggregated counts only; no PII.
COMMENT ON MATERIALIZED VIEW public.tenancy_orphan_summary IS
  'Per-table count of NULL organization_id rows on tenant business tables. Refreshed by the platform Tenancy Health card. Read-only for app_tenant; platform-only via requirePlatformOwner.';
