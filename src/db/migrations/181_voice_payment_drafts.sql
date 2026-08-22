-- ============================================================
-- 181_voice_payment_drafts.sql
-- Siri Phase 7 — recording money by voice.
--
-- Same two-step shape as 180_voice_workout_drafts, for the same reason and
-- with the stakes raised: /payments/prepare writes a proposal, and only
-- /payments/confirm — taking one id and nothing else — records the payment.
--
-- ── Why the amount cannot travel back from the phone ─────────────────
--
-- If /confirm accepted an amount, the confirmation would be theatre: the
-- sentence Siri read out ("Record 3,000 rupees for Rahul?") and the number
-- actually written would be two independent values, and nothing would tie
-- them together. Whatever the user agreed to is what must be recorded, so the
-- amount is stored here at prepare time and read from here at confirm time.
-- There is no field on the confirm request through which a different figure
-- could arrive.
--
-- ── Single use is not optional for money ─────────────────────────────
--
-- A duplicated workout is an annoyance. A duplicated payment is a client
-- credited twice and a ledger that no longer reconciles. `status` starts
-- 'pending' and /confirm claims it with
--   UPDATE … SET status='confirmed' WHERE id=$1 AND status='pending'
-- inside the transaction that inserts the ledger row, so two confirmations
-- racing produce one payment and one 409.
--
-- ── Short TTL ────────────────────────────────────────────────────────
--
-- Ten minutes, not the workout draft's thirty. A stale workout proposal is
-- built on stale facts; a stale PAYMENT proposal is a question about money
-- that somebody may since have answered another way — at the desk, in the
-- app, or in cash.
-- ============================================================

CREATE TABLE IF NOT EXISTS voice_payment_drafts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id        TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,

  -- Confirmable only by the account that prepared it. A colleague must not be
  -- able to complete a money write somebody else started.
  created_by       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','discarded')),

  -- NUMERIC, not a float: money. The CHECK is the last line of defence behind
  -- the route's own validation — a zero or negative "payment" is not a
  -- payment, and an unbounded one is a typo or a misheard number.
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount <= 10000000),
  payment_method   TEXT NOT NULL DEFAULT 'CASH',
  notes            TEXT,

  -- What the client owed when the question was asked. Kept so the audit trail
  -- can show the figure the person was looking at, which is not necessarily
  -- the figure at confirm time.
  balance_at_prepare NUMERIC(12,2),

  -- Set when confirmation actually recorded something.
  pt_payment_id    TEXT REFERENCES pt_payments(id) ON DELETE SET NULL,
  confirmed_at     TIMESTAMPTZ,

  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vpd_org_status_idx
  ON voice_payment_drafts (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS vpd_client_idx
  ON voice_payment_drafts (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS vpd_expiry_idx
  ON voice_payment_drafts (expires_at)
  WHERE status = 'pending';

-- ─── RLS ─────────────────────────────────────────────────────
-- Per the repo convention (src/__tests__/rls.convention.test.js): unreachable
-- through PostgREST with the publishable key, so the API is the only way in.
--
-- Direct WRITE access here would be a way to author a payment draft and then
-- confirm it through the API — recording money against any client, with the
-- organization and permission checks bypassed, because those run on the way
-- IN. Direct READ access would expose which clients owe what.
ALTER TABLE voice_payment_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON voice_payment_drafts FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON voice_payment_drafts;
CREATE POLICY deny_all_direct_access ON voice_payment_drafts
  FOR ALL USING (false) WITH CHECK (false);
