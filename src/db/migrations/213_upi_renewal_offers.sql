-- 213_upi_renewal_offers.sql
--
-- A trainer can send a member a renewal offer, and the member pays it by UPI
-- in the member app.
--
-- ── Why a third order kind ─────────────────────────────────────────────────
--
-- The two kinds so far (209):
--
--   membership  a studio plan at its list price. Approving it extends the
--               membership AND takes the payment off balance_amount — right
--               for a first purchase, wrong for a renewal: paying for a new
--               term must not quietly clear an older debt.
--   balance     what the member already owes. Buys no time.
--
-- A PT studio prices each client individually, so a renewal is not a plan off
-- a list: the trainer chooses the months and the price for this client and
-- sends it. Approving a renewal order starts the new term the way the
-- trainer's own Renew screen does (package fields, renewal history, term
-- history, ledger) and leaves any older balance exactly where it was.
--
-- ── Offers live for days ───────────────────────────────────────────────────
--
-- A checkout order expires after the studio's order_ttl_minutes. An offer is
-- sent and paid later, so its expires_at is set in days when it is created;
-- the existing expiry sweep then retires an unpaid offer on the same rule as
-- any other order.
--
-- ── Measured before writing (production, 2026-09-26) ───────────────────────
--
--   payment_orders: 0 rows. pt_clients: 35, 16 past their end date, 4 ending
--   within 30 days, prices set per client (final_amount on 22).
--
-- No BEGIN/COMMIT — migrate.js wraps this file in its own transaction.

-- ── 1. The kind ────────────────────────────────────────────────────────────
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_kind_check;
ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_kind_check CHECK (kind IN ('membership', 'balance', 'renewal'));

-- ── 2. A renewal buys time, like a membership ──────────────────────────────
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_duration_by_kind;
ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_duration_by_kind CHECK (
    (kind IN ('membership', 'renewal') AND duration_months BETWEEN 1 AND 120)
    OR (kind = 'balance' AND duration_months = 0)
  );

-- ── 3. One live offer per client ───────────────────────────────────────────
-- Sending a new offer cancels an unpaid one first (see createRenewalOffer);
-- this index is the backstop, so two trainers' tabs cannot leave a member
-- looking at two different prices for the same renewal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_orders_one_live_renewal
  ON payment_orders (organization_id, client_id)
  WHERE kind = 'renewal' AND status IN ('CREATED', 'PAYMENT_PENDING', 'VERIFICATION_PENDING');

COMMENT ON COLUMN payment_orders.kind IS
  'membership: a studio plan at list price. balance: the member''s outstanding '
  'balance. renewal: a new term the trainer offered this client, paid by UPI.';

-- ── Verification ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_orders_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%renewal%'
  ) THEN
    RAISE EXCEPTION '213: payment_orders_kind_check does not allow renewal';
  END IF;
END $$;
