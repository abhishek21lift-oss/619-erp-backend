-- ============================================================
-- 181_tenancy_known_gaps.sql
--
-- The Command Centre's Tenancy Health card surfaces "known
-- gaps" — tenant business tables that should carry
-- organization_id and currently do not. This is the same
-- information the convention test holds in KNOWN_GAPS
-- (src/__tests__/tenantColumns.convention.test.js), but the
-- card needs to read it through SQL, not by parsing a JS
-- file.
--
-- Seeded from the current KNOWN_GAPS so the value rendered
-- to the platform owner is the same value the build sees.
-- When a gap is closed (a migration adds the column), the
-- row stays in the table with verified_at set, and the
-- convention test removes it from KNOWN_GAPS — so the two
-- views stay in lockstep on the read path and the test
-- stays the source of truth on the write path.
--
-- Severity is one of 'high' | 'medium' | 'low'. New rows
-- default to 'medium' and a platform admin can downgrade
-- with a comment. The card groups by severity, not by
-- table count, so severity is the thing that matters.
--
-- No RLS on this table. It is platform-only, behind
-- requirePlatformOwner; the app_tenant role has no business
-- reading the list of things that are unprotected.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tenancy_known_gaps (
  table_name     TEXT        PRIMARY KEY,
  reason         TEXT        NOT NULL,
  severity       TEXT        NOT NULL DEFAULT 'medium'
                              CHECK (severity IN ('high', 'medium', 'low')),
  added_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at    TIMESTAMPTZ,
  closed_at      TIMESTAMPTZ
);

COMMENT ON TABLE public.tenancy_known_gaps IS
  'Tenant business tables that should carry organization_id and do not. Mirrors KNOWN_GAPS in src/__tests__/tenantColumns.convention.test.js. Platform-only; no RLS.';

-- Seed from the current KNOWN_GAPS list. ON CONFLICT DO NOTHING
-- so a re-run after a hand edit is safe. The "reason" column
-- matches the test's commentary, not paraphrased.
INSERT INTO public.tenancy_known_gaps (table_name, reason, severity) VALUES
  ('system_settings',
   'Per-studio keys (branch_N) inside a shared table. Reviewed exception in tenantScope.convention.test.js; a real column would be better.',
   'high'),
  ('feature_flags',
   'Studio feature toggles, admin-only, read through settings routes.',
   'low'),
  ('payments',
   'Legacy payment rows. The live path is pt_payments (which carries the column) and payment_orders; this table is read by invoices.js and the Razorpay webhook.',
   'medium'),
  ('clients',
   'The legacy table migration 170 drops. Still referenced by admin-reset and clients.js.',
   'medium'),
  ('notification_log',
   'Delivery log, WRITE-ONLY — nothing in the codebase SELECTs from it, so there is no read path to cross studios. It should carry the column (a delivery audit trail that cannot name the studio is a poor one), but adding it means changing the INSERT and deciding what an org-less system notification records.',
   'low')
ON CONFLICT (table_name) DO NOTHING;
