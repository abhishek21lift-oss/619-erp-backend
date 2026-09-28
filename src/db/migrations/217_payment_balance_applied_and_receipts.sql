-- 217_payment_balance_applied_and_receipts.sql
--
-- Payments & Invoices audit 2026-09-28 (docs/PAYMENTS-AUDIT-2026-09-28.md).
--
-- ── PAY-3: how much of a payment actually reduced the balance ────────────────
--
-- Recording a payment moves the client's balance by LEAST(amount, balance):
-- the balance is clamped at zero. Deleting one added the FULL amount back. So
-- a ₹1,500 payment against ₹1,000 owed, once deleted, left ₹1,500 owing — more
-- than was ever due — and deleting a UPI package purchase (which never touches
-- the balance at all) added its whole amount to it.
--
-- balance_applied is the amount this payment took off balance_amount, written
-- at insert by every path that moves the balance. DELETE reverses exactly
-- that. NULL on rows written before this column existed; DELETE falls back to
-- the old behaviour for those, because what they applied was never recorded.
--
-- ── PAY-6: every payment has a receipt number ───────────────────────────────
--
-- Enrolment and renewal wrote payments without one — 28 of the 42 in
-- production. From now on every path issues one from receipt_no_seq
-- (migration 214). Existing rows are numbered here, oldest first, in the same
-- RCP-YYYYMMDD-NNNNNN shape; the date part is the payment's own date, so a
-- receipt reads as issued on the day the money came in. Only NULL references
-- are filled; nothing already issued is renumbered.

ALTER TABLE pt_payments ADD COLUMN IF NOT EXISTS balance_applied NUMERIC(12,2);

COMMENT ON COLUMN pt_payments.balance_applied IS
  'Amount this payment removed from pt_clients.balance_amount; DELETE restores exactly this. NULL = recorded before migration 217.';

-- A loop rather than one UPDATE: nextval() in an UPDATE is assigned in
-- whatever order the executor visits rows, and "oldest payment, lowest
-- receipt number" is only true if the order is forced.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id, COALESCE(date, created_at::date) AS d
      FROM pt_payments
     WHERE payment_ref IS NULL
     ORDER BY created_at, id
  LOOP
    UPDATE pt_payments
       SET payment_ref = 'RCP-' || to_char(r.d, 'YYYYMMDD') || '-' || lpad(nextval('receipt_no_seq')::text, 6, '0')
     WHERE id = r.id;
  END LOOP;
END $$;
