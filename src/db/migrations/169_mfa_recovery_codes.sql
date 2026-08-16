-- ============================================================
-- 169_mfa_recovery_codes.sql
--
-- Storage for MFA recovery codes, which until now were issued but never
-- kept.
--
-- POST /api/profile/mfa/verify generated eight random codes, returned them,
-- and dropped them on the floor — no table, no column, no redemption path
-- anywhere in the codebase. The Settings dialog that displays them says:
--
--   "Store these somewhere safe. Each code can be used once to get back
--    into your account if you lose access to your authenticator app."
--
-- That was false in two independent ways, both verified against a running
-- server:
--
--   1. Nothing persisted them, so there was nothing to check a code against.
--   2. Login validates mfa_code as /^\d{6}$/, and the codes are eight hex
--      characters — so a recovery code was rejected as malformed before any
--      lookup could even have happened.
--
-- For the platform super admin this is the difference between a lost phone
-- and a lost platform: it is the only account that can reach the operator
-- console, and SUPER_ADMIN_REQUIRE_MFA turns that second factor into a hard
-- requirement.
--
-- ── Why SHA-256 and not bcrypt ──────────────────────────────────────────
--
-- Passwords are low-entropy and human-chosen, so they need a deliberately
-- slow KDF. These are 64 bits from crypto.randomBytes, which is far past
-- brute-force range, so the reason for a slow hash does not apply — and a
-- slow hash here would be actively harmful: verification has to test a
-- submitted code against every unused code on the account, and eight bcrypt
-- comparisons at cost 12 is on the order of two seconds added to a login.
--
-- SHA-256 of the normalised code, stored hex, with a UNIQUE index. That
-- makes redemption a single indexed lookup rather than a scan-and-compare,
-- and the digest is what is unique — never the code itself, which is not
-- stored in any form.
-- ============================================================

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex of the upper-cased code. The code itself is never stored.
  code_hash   TEXT        NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Redemption looks a code up by its digest alone, so the digest has to be
-- unique platform-wide or one account's code could match another's row.
-- 64 bits of randomness makes a genuine collision vanishingly unlikely; the
-- constraint is what makes that an enforced fact rather than an assumption.
CREATE UNIQUE INDEX IF NOT EXISTS mfa_recovery_codes_hash_uniq
  ON mfa_recovery_codes(code_hash);

-- "The unused codes for this user", which is every read this table serves.
CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_unused_idx
  ON mfa_recovery_codes(user_id) WHERE used_at IS NULL;

-- ── RLS ─────────────────────────────────────────────────────────────────
--
-- This table has no organization_id and never will: a recovery code belongs
-- to a user, and the platform super admin — the account that most needs one
-- — has no organization at all. So migration 157's schema scan does not
-- cover it, and 159's reasoning applies instead: a table with RLS enabled
-- and no applicable policy returns zero rows silently once DATABASE_URL is
-- cut over to app_tenant, which here would mean every recovery code quietly
-- ceasing to work.
--
-- Scoped by user rather than by organization, using the same GUC the tenant
-- policies read. Granted only to app_tenant; the deny-all policies that
-- protect anon/authenticated are untouched.
--
-- Note this is deliberately NOT readable cross-user even by a studio admin:
-- a recovery code is a credential, and the only paths that touch this table
-- are the account's own enrolment and its own login.
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE 'DROP POLICY IF EXISTS own_recovery_codes ON public.mfa_recovery_codes';
    EXECUTE
      'CREATE POLICY own_recovery_codes ON public.mfa_recovery_codes FOR ALL TO app_tenant '
      || 'USING (user_id = current_setting(''app.user_id'', true)) '
      || 'WITH CHECK (user_id = current_setting(''app.user_id'', true))';
  END IF;
END $$;

-- Revoke from the PostgREST roles, matching the house pattern (130, 148):
-- nothing outside the API has any business reading this table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.mfa_recovery_codes FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.mfa_recovery_codes FROM authenticated';
  END IF;
END $$;
