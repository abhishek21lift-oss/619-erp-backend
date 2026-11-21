-- 285_impersonation_sessions.sql
-- A revocable record for every operator impersonation.
--
-- Before this table an impersonation was a signed JWT and nothing else. That
-- meant:
--
--   * no way to end a session early — the only lever was bumping the TARGET's
--     token_version, which force-logs-out the studio's real trainer too;
--   * no record that a session was still open, so the console could not show
--     "operator X is inside studio Y right now";
--   * no reason stored with the grant, and no place to hang the actions taken
--     during it beyond a single "user_impersonated" activity row.
--
-- This table is the missing session object. The JWT carries its id (`sid`);
-- auth.js checks the row on every request, so `ended_at`/`revoked_at` kill an
-- in-flight token immediately rather than at its TTL.
--
-- ids are TEXT for users because the identity tables have always used TEXT
-- ids (001_v4_upgrade); organizations are UUID. Mixing them is deliberate and
-- matches the columns they reference.
CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The operator who minted the session.
  operator_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The studio account the token acts as.
  target_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  mode             TEXT NOT NULL CHECK (mode IN ('read_only', 'full')),
  -- Why this studio, this account, right now. Required at mint so the audit
  -- trail answers the question an incident review actually asks.
  reason           TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  -- The JWT's jti. Unique so a token cannot name another session's record.
  jti              TEXT NOT NULL UNIQUE,
  ip               INET,
  user_agent       TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  -- Why the session is over. NULL while active.
  end_reason       TEXT CHECK (end_reason IN ('operator_exit', 'revoked', 'expired', 'target_revoked')),
  revoked_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at       TIMESTAMPTZ,
  CONSTRAINT impersonation_sessions_window CHECK (expires_at > started_at),
  CONSTRAINT impersonation_sessions_ended_has_reason
    CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);

-- "What is this operator doing right now" and "what happened to this studio".
CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_operator
  ON impersonation_sessions (operator_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_org
  ON impersonation_sessions (organization_id, started_at DESC);
-- Partial index for the active-session sweep the console runs.
CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_active
  ON impersonation_sessions (started_at DESC)
  WHERE ended_at IS NULL;

-- Every mutating request made during a full-access session. Read-only sessions
-- cannot write, so they produce no rows here by construction.
--
-- Kept beside the session rather than in activity_log because these are
-- transport-level facts (method, path, status) with no domain meaning; the
-- domain-level writes still go through activityLog with `_impersonated_by`.
CREATE TABLE IF NOT EXISTS impersonation_session_actions (
  id           BIGSERIAL PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES impersonation_sessions(id) ON DELETE CASCADE,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  status_code  INTEGER,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_impersonation_session_actions_session
  ON impersonation_session_actions (session_id, at DESC);

-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- Platform-only rows: no studio owns an impersonation session, and no tenant
-- role has any business reading who entered which studio or why. The console
-- reaches both tables over the owner connection; FORCE makes the deny-all
-- policy apply even to the table owner unless it holds BYPASSRLS, so a future
-- grant to app_tenant cannot quietly expose the audit trail.
ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE impersonation_session_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_session_actions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deny_all_direct_access ON impersonation_sessions;
CREATE POLICY deny_all_direct_access ON impersonation_sessions
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS deny_all_direct_access ON impersonation_session_actions;
CREATE POLICY deny_all_direct_access ON impersonation_session_actions
  FOR ALL USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.impersonation_sessions FROM anon';
    EXECUTE 'REVOKE ALL ON public.impersonation_session_actions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.impersonation_sessions FROM authenticated';
    EXECUTE 'REVOKE ALL ON public.impersonation_session_actions FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE 'REVOKE ALL ON public.impersonation_sessions FROM app_tenant';
    EXECUTE 'REVOKE ALL ON public.impersonation_session_actions FROM app_tenant';
  END IF;
END $$;
