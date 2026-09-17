-- ============================================================
-- 205_subscription_invoice_sequence.sql
--
-- Invoice numbers were assigned with `SELECT count(*)+1 FROM
-- subscription_invoices` inside the activation transaction (lib/subscription.js
-- activate()), guarded only by a PER-ORGANIZATION advisory lock
-- (`pg_advisory_xact_lock(hashtext(orgId))`). That lock does nothing for two
-- DIFFERENT organizations activating at nearly the same moment: under READ
-- COMMITTED, both transactions can read the same count before either
-- commits, and both then try to INSERT the same invoice_number into a column
-- that is NOT NULL UNIQUE (099_subscription_foundation.sql). The resulting
-- unique-violation was not specifically handled (only the `live_reference`
-- conflict was), so it aborted the WHOLE activation transaction — rolling
-- back a legitimate payment, invoice, and any founder-slot grant because two
-- unrelated studios happened to activate within the same instant.
--
-- A real sequence fixes this: nextval() is atomic under Postgres MVCC and
-- can never hand the same number to two callers, no matter how many
-- transactions call it concurrently, with no lock required. It can leave
-- gaps if a transaction that called nextval() later rolls back — an accepted
-- trade-off for invoice numbering (uniqueness matters; strict gaplessness
-- does not), and strictly better than the previous behavior of the entire
-- payment failing to record at all.
--
-- Start the sequence where count-based numbering had already reached, so
-- numbering continues rather than restarting from 1.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS subscription_invoice_seq;

-- is_called = false: the value itself has not been consumed yet, so the
-- very next nextval() returns exactly count+1 — matching the old formula's
-- first result exactly, with no off-by-one and no lower-bound issue when
-- the table is empty (count=0 → next value 1, always >= sequence minvalue).
SELECT setval(
  'subscription_invoice_seq',
  (SELECT count(*) + 1 FROM subscription_invoices),
  false
);
