-- ============================================================
-- 270_google_identity.sql
--
-- Google sign-in identity for studio accounts.
--
-- A Google subject id is stable; an email address is not. Linking is keyed
-- on the subject (`google_sub`), and the email is only a lookup hint for the
-- first explicit link. No account is linked by matching email alone.
--
-- Additive and idempotent. Existing accounts stay unlinked until their owner
-- proves the account password through POST /api/auth/google-link.
--
-- The login_events half is a pre-existing defect: password login records
-- WRONG_PORTAL, but migration 125's CHECK rejects it and loginEvents.record()
-- swallows the error, so those audit rows never existed. Google records the
-- same outcome, so the constraint must allow it.
--
-- The unique partial index takes a brief write lock on users. It is created
-- only after the column exists, and the migration runner wraps this file in
-- its usual transaction.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_linked_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique
  ON users (google_sub) WHERE google_sub IS NOT NULL;

-- Postgres named migration 125's inline CHECK after its table and column.
-- If a live database named it differently, DROP ... IF EXISTS is a no-op and
-- both constraints stay enforced. Verify before applying:
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'login_events'::regclass AND contype = 'c';
ALTER TABLE login_events DROP CONSTRAINT IF EXISTS login_events_outcome_check;
-- NOT VALID, then VALIDATE: adding a CHECK normally scans the table under an
-- ACCESS EXCLUSIVE lock, and this table grows with every sign-in attempt.
-- VALIDATE takes the lighter SHARE UPDATE EXCLUSIVE lock instead.
ALTER TABLE login_events ADD CONSTRAINT login_events_outcome_check
  CHECK (outcome IN ('success', 'bad_password', 'unknown_user',
                     'inactive', 'mfa_required', 'mfa_failed', 'wrong_portal'))
  NOT VALID;
ALTER TABLE login_events VALIDATE CONSTRAINT login_events_outcome_check;
