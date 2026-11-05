-- ─────────────────────────────────────────────────────────────────────────
-- 266 — One payment per idempotency key
-- ─────────────────────────────────────────────────────────────────────────
--
-- Both manual money paths (POST /api/payments and POST /api/pt-os/payments)
-- write through lib/ptPayments.recordPtPayment. A retry after a committed
-- write — a lost response, a proxy reset, a double tap — used to credit the
-- client twice, because the ledger had no way to recognise the second
-- request. The frontend now sends a per-form UUID; this column and index make
-- that key the database's guarantee, not the screen's.
--
-- Partial: existing rows (and API clients that send no key) stay NULL and do
-- not collide — NULLs are distinct in a unique index anyway, but the WHERE
-- clause keeps the index small and states the intent.
--
-- Idempotent; safe to re-run.

ALTER TABLE pt_payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS pt_payments_org_idempotency_key
  ON pt_payments (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
