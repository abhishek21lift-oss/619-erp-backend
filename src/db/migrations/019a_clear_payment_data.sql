-- ============================================================
-- 019_clear_payment_data.sql
-- Clears all existing payment data for a fresh start.
-- ============================================================

DELETE FROM pt_payments;
DELETE FROM payments;
