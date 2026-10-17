-- Hostinger super admin: the encrypted API credential and the approval gate.
--
-- ── Why these two tables are not just columns on something that exists ──────
--
-- 1. The token. Every other integration in this repo either has no secret
--    (whatsapp_instances), stores one in plaintext (integrations.api_key,
--    google_calendar_tokens) or has had its credential-writing route deleted
--    outright (routes/integrations.js). None of those is a shape to copy for a
--    token that can restart a production VPS. This is the first credential in
--    the codebase written with encryption at rest, and the column stores an
--    ENVELOPE (`v1.<iv>.<tag>.<ciphertext>`), never the token.
--
-- 2. The approval. Destructive operations (restore a backup, recreate a
--    machine, delete DNS records) must not be one POST away from a mis-click.
--    The plan is stored, the operator approves the STORED plan, and execute
--    re-resolves the parameters from this row rather than from the request —
--    so "what was approved" and "what ran" cannot diverge. ai_action_plans has
--    the same shape but belongs to the AI-actions domain and its registry; a
--    second writer there would make two modules own one lifecycle.
--
-- Operation history is deliberately NOT a third table: activity_log already
-- answers "who did what, when, with what result" for the platform plane, and
-- the console reads it back with action LIKE 'hostinger.%'.

-- ── 1. The credential ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_hostinger_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label         TEXT NOT NULL,
  -- `v1.<iv-b64>.<tag-b64>.<ciphertext-b64>`: AES-256-GCM, random 12-byte IV
  -- per write. The version prefix is what makes a future key rotation possible
  -- without guessing which key wrote which row.
  token_ciphertext TEXT NOT NULL,
  -- sha256 of the token, hex, first 16 chars. Lets the console say "this is the
  -- token you already stored" and lets a rotate record which token was
  -- replaced, WITHOUT the value being recoverable from the column.
  token_fingerprint TEXT NOT NULL,
  -- Last four characters, for a human to recognise the token in hPanel.
  -- Never enough to authenticate: Hostinger tokens are ~50 characters.
  token_hint    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Last live verification against the API (a real read call, not a timer).
  last_verified_at     TIMESTAMPTZ,
  last_verified_status TEXT,
  last_error           TEXT
);

-- One live token at a time, enforced by the database rather than by hoping the
-- rotate path is the only writer. The index is on the constant expression
-- `status`, so every live row collides on the same key: a second INSERT with
-- status='active' fails, and revocation frees the slot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hostinger_credential_active
  ON platform_hostinger_credentials ((status)) WHERE status = 'active';

-- ── 2. The approval ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_hostinger_approvals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Catalogue id (e.g. `vps.docker.restart`). Validated against the catalogue
  -- before insert, and again before execute.
  operation   TEXT NOT NULL,
  -- The exact parameters shown to the operator. Execute reads THESE, never the
  -- request body.
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- sha256 over operation + the resolved params. Any drift between the plan and
  -- what the operator believes they approved surfaces as a mismatch, not as an
  -- executed operation on different inputs.
  fingerprint TEXT NOT NULL,
  -- 'mutate' | 'destructive'. Stored so the UI and the execute path agree about
  -- what kind of confirmation is owed.
  safety      TEXT NOT NULL,
  -- What was displayed: resolved target, human summary, the API path. Kept so an
  -- audit can answer "what did they approve?" rather than only "what ran?".
  summary     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- users.id is TEXT, not UUID — seeded platform admins carry ids like
  -- 'usr-superadmin-001'. user-id-columns.test.js exists because this exact
  -- mistake has shipped three times from other migrations.
  actor       TEXT NOT NULL,
  actor_name  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'consumed', 'expired', 'denied')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  result      JSONB
);

-- Execution looks a plan up by id and actor; nothing scans this table broadly.
CREATE INDEX IF NOT EXISTS platform_hostinger_approvals_actor_idx
  ON platform_hostinger_approvals (actor, created_at DESC);

-- Lets the cleanup on read find expired, never-approved plans.
CREATE INDEX IF NOT EXISTS platform_hostinger_approvals_expiry_idx
  ON platform_hostinger_approvals (expires_at)
  WHERE consumed_at IS NULL;

-- ── RLS: deny-all, exactly as platform_owners ───────────────────────────────
--
-- Both tables are reachable only from the platform plane, which runs over the
-- owner connection (db/pool.js routes there when isPlatformWide()). FORCE means
-- the policy binds the table owner too, so a future grant to app_tenant does not
-- silently open a table of credentials — the same reasoning migration 161
-- applied to platform_owners, and that table is read on every platform request
-- today, which is the proof this shape works in production.
ALTER TABLE platform_hostinger_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_hostinger_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_hostinger_approvals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_hostinger_approvals   FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'platform_hostinger_credentials'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON platform_hostinger_credentials
      FOR ALL USING (false) WITH CHECK (false);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'platform_hostinger_approvals'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON platform_hostinger_approvals
      FOR ALL USING (false) WITH CHECK (false);
  END IF;

  -- Guarded: anon/authenticated are Supabase roles and do not exist on a plain
  -- Postgres. Migrations run automatically at boot, so an unguarded REVOKE
  -- would abort the boot of any deployment that is not Supabase.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON platform_hostinger_credentials FROM anon;
    REVOKE ALL ON platform_hostinger_approvals   FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON platform_hostinger_credentials FROM authenticated;
    REVOKE ALL ON platform_hostinger_approvals   FROM authenticated;
  END IF;
END $$;
