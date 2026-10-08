-- ─────────────────────────────────────────────────────────────────────────
-- 228 — Refresh tokens remember the token_version they were issued under
-- ─────────────────────────────────────────────────────────────────────────
--
-- Security audit 2026-10-08. Bumping users.token_version is how this app ends
-- every session: "sign out everywhere", deactivating a member, suspending or
-- deleting a studio, an operator's password reset. It killed access tokens
-- (auth middleware compares the version) but not refresh tokens: /refresh
-- minted a fresh access token with the user's CURRENT version, so a stolen
-- refresh token survived every one of those, renewing itself on each rotation.
--
-- Each refresh token now records the version it was issued under, and
-- /refresh refuses one whose version has moved on. Every existing and future
-- token_version bump revokes refresh tokens without having to remember to.
--
-- Existing rows are stamped with their user's current version, so nobody is
-- signed out by this migration; tokens already outliving a past bump expire
-- within their 7-day window as before.
--
-- No BEGIN/COMMIT — migrate.js wraps this together with the _migrations insert.

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_version INTEGER;

UPDATE refresh_tokens rt
   SET token_version = u.token_version
  FROM users u
 WHERE u.id = rt.user_id
   AND rt.token_version IS NULL;
