-- Absolute session lifetime for rotating refresh tokens.
--
-- `expires_at` bounds ONE token. Rotation used to issue a new seven-day row on
-- every use, so a session that was used never ended — a forgotten laptop kept
-- minting access tokens for as long as it was opened. This column records when
-- the SESSION began; POST /api/auth/refresh carries it forward and refuses a
-- session older than REFRESH_SESSION_MAX_DAYS (default 30).
--
-- Backfill uses created_at, which is the best available evidence of when each
-- existing session started. It is lenient rather than strict: created_at is the
-- current token's birth, not necessarily the first in its chain, so an existing
-- session gets up to one more full window instead of being cut off mid-use. The
-- cap binds from the next rotation onward.
--
-- Additive and idempotent. The code falls back to created_at on undefined
-- column, so a deployment that serves for a moment before this lands keeps
-- working.

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ;

UPDATE refresh_tokens
   SET session_started_at = created_at
 WHERE session_started_at IS NULL;

ALTER TABLE refresh_tokens
  ALTER COLUMN session_started_at SET DEFAULT NOW();

ALTER TABLE refresh_tokens
  ALTER COLUMN session_started_at SET NOT NULL;

COMMENT ON COLUMN refresh_tokens.session_started_at IS
  'When the session began. Carried forward unchanged on every rotation; the '
  'absolute lifetime check reads this, not expires_at (which is per token).';
