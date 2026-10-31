-- 250_form_links.sql
--
-- One-time links that let an online client fill and sign their PAR-Q and
-- informed consent on their own phone, before they have a login and before
-- they are enrolled in a PT package.
--
-- ── Why this is its own table ──────────────────────────────────────────────
--
-- client_invitations already issues single-use, hashed, expiring tokens, but
-- an invitation is a login credential and its lifecycle ends in an account.
-- A form link ends in a signature and must work with no account at all. Reusing
-- the invitation table would mean a token whose purpose is ambiguous — and a
-- bug that treats a signing link as a login, or the reverse, is exactly the
-- kind of mistake the separate table makes impossible.
--
-- Only SHA-256(raw) is stored. The raw token is returned once, goes into the
-- email or WhatsApp message, and is never persisted.
--
-- ── Why a used link is kept ────────────────────────────────────────────────
--
-- used_at is evidence of when the client signed, and the row is what stops a
-- retried submission from writing a second PAR-Q. Deleting it would erase both.

CREATE TABLE IF NOT EXISTS pt_form_links (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id UUID NOT NULL,
  client_id       TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Issuing a new link looks up the client's live one to expire it first.
CREATE INDEX IF NOT EXISTS pt_form_links_client
  ON pt_form_links (client_id, expires_at DESC);

-- ── Tenant isolation ────────────────────────────────────────────────────────
-- Same shape as migration 248: deny direct access, then let app_tenant see
-- only rows for the organization in the request context. The public signing
-- route reads through the owner role, like every other server-side lookup.

ALTER TABLE pt_form_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pt_form_links FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON pt_form_links;
CREATE POLICY deny_all_direct_access ON pt_form_links
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON pt_form_links;
CREATE POLICY tenant_isolation ON pt_form_links FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON pt_form_links TO app_tenant;

COMMENT ON TABLE pt_form_links IS
  'One-time, hashed token that lets a client sign their screening remotely (migration 250).';
COMMENT ON COLUMN pt_form_links.token_hash IS
  'SHA-256 of the raw token. The raw value exists only in the sent message.';
COMMENT ON COLUMN pt_form_links.used_at IS
  'Set when the signed forms are committed. A used link cannot be replayed.';
