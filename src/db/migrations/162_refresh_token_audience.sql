-- 162_refresh_token_audience.sql
-- Which plane a refresh token may re-open a session for.
--
-- Migration 161 and middleware/platformAuth.js put an audience on the access
-- token: a session opened at the Command Center door is marked `platform`, one
-- opened at the studio door is marked `tenant`, and the control plane refuses
-- anything that is not `platform`.
--
-- Access tokens live 15 minutes. Refresh tokens live weeks, and POST
-- /auth/refresh mints a brand-new access token from one. So without this
-- column the audience is laundered on the first refresh: a token minted at the
-- studio door comes back fifteen minutes later as whatever the refresh handler
-- decides to stamp on it, and every distinction 161 draws is gone by lunchtime.
--
-- The audience therefore has to be a property of the SESSION, not of the
-- access token, and the refresh token is the only thing that survives long
-- enough to carry it.
--
-- NULL means a session opened before this column existed. It is read as
-- "legacy" rather than defaulted to 'tenant', for the same reason
-- platformAuth.js distinguishes a missing `aud` from a tenant one: while
-- PLATFORM_SESSION_ENFORCE is off, legacy sessions work on both planes; once
-- it is on, they work on neither and the holder signs in again. Defaulting
-- them to 'tenant' would instead silently downgrade the operator's live
-- session and look like a bug in the console.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS audience TEXT;

COMMENT ON COLUMN refresh_tokens.audience IS
  'Which plane this session belongs to: ''platform'' (Command Center) or '
  '''tenant'' (MY PT STUDIO). NULL = issued before audiences existed. '
  'Read by POST /api/auth/refresh so a refresh cannot change planes.';

-- No CHECK constraint on the value. The set of audiences is defined in
-- middleware/platformAuth.js, and a constraint here would mean any future
-- plane needs a migration deployed strictly before the code that writes it —
-- the ordering that turns an additive change into an outage.
