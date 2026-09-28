-- 216_mfa_last_step.sql
--
-- The time-step of the last TOTP code accepted at sign-in, per user.
--
-- A TOTP code stays valid for its whole 30-second step (and, with the one-step
-- tolerance, the neighbouring ones). Without a record of which step was last
-- used, a code seen once (shoulder-surfed, phished in real time, lifted from a
-- proxy log) could be replayed to sign in again inside that window. The
-- operator console is the only door that asks for TOTP today (Command Center
-- audit 2026-09-28, CC-8).
--
-- routes/auth.js accepts a code only if its step is greater than this value
-- and moves the value forward in the same UPDATE, so two concurrent logins
-- with one code cannot both succeed.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT;
