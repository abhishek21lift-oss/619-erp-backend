-- 214_receipt_no_sequence.sql
--
-- The receipt-number sequence, created by the migration owner.
--
-- ── Why this is a migration now ────────────────────────────────────────────
--
-- db/receipts.js created receipt_no_seq lazily, with CREATE SEQUENCE IF NOT
-- EXISTS on every call. Postgres checks the CREATE privilege on the schema
-- BEFORE it looks for the object, so the statement fails for a role without
-- that privilege even when the sequence is already there.
--
-- app_tenant (157) is exactly such a role, correctly: the API serving as the
-- tenant must not be able to create objects. Under it every receipt failed
-- with "permission denied for schema public", which is every payment
-- recorded from Finance and — since both manual-payment screens were routed
-- through lib/ptPayments.js — every payment recorded from a client's
-- Payments tab too. The E2E suite, which serves as app_tenant, is where it
-- surfaced.
--
-- Created here by the owner, the sequence is covered by 157's
-- ALTER DEFAULT PRIVILEGES, and the explicit GRANT below covers a database
-- where the sequence already existed before this migration (created lazily
-- by the owner, when the API still served as the owner).

CREATE SEQUENCE IF NOT EXISTS receipt_no_seq START 100001;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE receipt_no_seq TO app_tenant;
  END IF;
END $$;
