-- ============================================================
-- 206_renewal_charge_marker.sql
--
-- src/workers/renewal.worker.js's auto-renew charges a member via Razorpay
-- and then, in the SAME transaction, rolls the membership over (new row,
-- old row -> 'expired'). If the process dies after the Razorpay charge
-- succeeds but before that transaction commits, the ROLLBACK correctly
-- leaves the old membership row `status='active', end_date=CURRENT_DATE` —
-- which is exactly the WHERE clause the next run (cron, or an operator
-- manually re-running the one-shot script suspecting a partial failure)
-- selects on. The Razorpay charge already happened and is not something a
-- Postgres ROLLBACK can undo; re-running charges the member again.
-- BullMQ's `attempts: 1` only stops an AUTOMATIC retry of the same job — it
-- does nothing for a manual re-run in a new process.
--
-- These two columns are a marker written in its OWN statement, immediately
-- after the Razorpay charge succeeds and before the rollover transaction
-- opens — so it survives even if that transaction later rolls back. The
-- worker checks it before charging and skips (logging for manual
-- reconciliation) rather than charging twice.
-- ============================================================

ALTER TABLE member_memberships
  ADD COLUMN IF NOT EXISTS last_renewal_charge_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_renewal_order_id  TEXT;
