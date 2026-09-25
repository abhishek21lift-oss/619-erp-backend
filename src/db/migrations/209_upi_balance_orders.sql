-- 209_upi_balance_orders.sql
--
-- A member can pay their outstanding PT balance by UPI.
--
-- Until now every UPI order was a membership sale: it named a plan, carried a
-- duration, and approving it extended pt_end_date. A member who owed money on
-- a package they already had could not pay it online at all — the only order
-- they could create bought a NEW plan at its list price.
--
-- A balance order is the second kind. Its amount is read from
-- pt_clients.balance_amount on the server (never from the request), it buys
-- no time, and approving it moves money from balance_amount to paid_amount
-- without touching the membership window.
--
-- ── Measured before writing (production, 2026-09-25) ───────────────────────
--
--   payment_orders_duration_months_check   CHECK (duration_months 1..120)
--   membership_payments_window             CHECK (activated_to > activated_from)
--   payment_audit_logs_action_check        11 actions, no balance action
--   pt_clients with balance_amount > 0:    3 of 35
--
-- Runs inside the migrator's own transaction. Every step is idempotent.
-- Existing rows are all membership orders, which the column default and the
-- rewritten checks keep valid unchanged.

-- ── 1. The order kind ──────────────────────────────────────────────────────
ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'membership';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_orders_kind_check') THEN
    ALTER TABLE payment_orders
      ADD CONSTRAINT payment_orders_kind_check CHECK (kind IN ('membership', 'balance'));
  END IF;
END $$;

-- ── 2. Duration depends on the kind ────────────────────────────────────────
-- A balance order buys no time, so it carries 0 — not a made-up "1 month"
-- that a receipt or report would then print as if it were true.
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_duration_months_check;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_orders_duration_by_kind') THEN
    ALTER TABLE payment_orders
      ADD CONSTRAINT payment_orders_duration_by_kind CHECK (
        (kind = 'membership' AND duration_months BETWEEN 1 AND 120)
        OR (kind = 'balance' AND duration_months = 0)
      );
  END IF;
END $$;

-- ── 3. An approved balance payment activates no window ─────────────────────
ALTER TABLE membership_payments ALTER COLUMN activated_from DROP NOT NULL;
ALTER TABLE membership_payments ALTER COLUMN activated_to   DROP NOT NULL;

ALTER TABLE membership_payments DROP CONSTRAINT IF EXISTS membership_payments_window;
ALTER TABLE membership_payments
  ADD CONSTRAINT membership_payments_window CHECK (
    (activated_from IS NULL AND activated_to IS NULL)
    OR (activated_from IS NOT NULL AND activated_to IS NOT NULL AND activated_to > activated_from)
  );

-- ── 4. Audit vocabulary ────────────────────────────────────────────────────
ALTER TABLE payment_audit_logs DROP CONSTRAINT IF EXISTS payment_audit_logs_action_check;
ALTER TABLE payment_audit_logs
  ADD CONSTRAINT payment_audit_logs_action_check CHECK (action IN (
    'ORDER_CREATED','ORDER_REUSED','INTENT_OPENED','UTR_SUBMITTED',
    'SCREENSHOT_UPLOADED','APPROVED','REJECTED','CORRECTION_REQUESTED',
    'CANCELLED','EXPIRED','MEMBERSHIP_ACTIVATED','BALANCE_SETTLED'
  ));

