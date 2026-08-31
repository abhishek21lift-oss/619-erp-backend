-- Migration 184: Admin reset OTP rate-limit columns
--
-- Adds attempt tracking to admin_reset_intents to prevent OTP brute-force
-- attacks on the two-step admin reset flow (P1-5).
--
-- The flow:
--   1. POST /admin/initiate-reset  → emails a 6-digit OTP, stores hash
--   2. POST /admin/reset-all-data  → Body: { otp: "123456" }
--
-- Before this migration, an attacker with a stolen admin session token could
-- brute-force the 6-digit OTP (1M combinations) using only the per-API
-- rate limit. With the new columns, each intent locks after N failed
-- attempts, requiring a fresh /initiate-reset call.
--
-- attempt_count    Total failed OTP attempts against this intent
-- last_attempt_at  When the most recent (successful OR failed) attempt happened
-- locked_until     If set, OTP verification is refused until this time

ALTER TABLE admin_reset_intents
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE admin_reset_intents
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

ALTER TABLE admin_reset_intents
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- After 5 failed attempts, lock for 15 minutes.
-- The check is enforced in routes/admin-reset.js, not by a CHECK constraint,
-- because the lock window is policy, not integrity.

COMMENT ON COLUMN admin_reset_intents.attempt_count IS
  'Number of failed OTP attempts. Lock kicks in at 5.';
COMMENT ON COLUMN admin_reset_intents.locked_until IS
  'If set in the future, OTP verification is refused until this time.';
