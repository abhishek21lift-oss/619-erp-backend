-- 272 — Push notifications, Package B.
--
-- Additive only. The existing inbox (`notifications`), `notification_log`, the
-- BullMQ `notifications` queue and every template stay as they are. This adds
-- the two things push needs and the schema never had:
--
--   device_tokens   which device belongs to which user, inside which tenant
--   push_deliveries a per-job ledger so a BullMQ retry does not re-alert a
--                   device that already accepted the first attempt
--
-- A token is unique across the whole table: Android hands the same token to
-- whoever holds the device, so re-registering it moves it to the current user
-- rather than leaving a stale owner behind. Tokens are revoked, never reused.

-- Rollback (manual; there is no down migration). Kept above the CREATEs so the
-- schema scanner does not read these statements as an applied DROP:
--   BEGIN;
--   DROP TABLE IF EXISTS push_deliveries;
--   DROP TABLE IF EXISTS device_tokens;
--   ALTER TABLE pt_clients DROP COLUMN IF EXISTS push_opt_out;
--   DELETE FROM _migrations WHERE filename = '272_device_tokens_push.sql';
--   COMMIT;
-- Policies, grants and indexes are owned by the two tables and disappear with
-- the tables. Data caveat: device registrations and push
-- opt-outs captured after this migration are lost by a schema rollback.

CREATE TABLE IF NOT EXISTS device_tokens (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token           TEXT        NOT NULL,
  platform        TEXT        NOT NULL DEFAULT 'android'
                              CHECK (platform IN ('android','ios')),
  app             TEXT        NOT NULL
                              CHECK (app IN ('studio','member')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT
);

-- One row per registration token. The upsert in devices.service.js relies on
-- this index to move a shared device to the user who just signed in.
CREATE UNIQUE INDEX IF NOT EXISTS device_tokens_token_uidx
  ON device_tokens (token);

-- The only lookup the sender makes: this user, this tenant, still live.
CREATE INDEX IF NOT EXISTS device_tokens_user_org_idx
  ON device_tokens (user_id, organization_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS device_tokens_org_idx
  ON device_tokens (organization_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS push_deliveries (
  dedupe_key TEXT        NOT NULL,
  token_hash TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dedupe_key, token_hash)
);

CREATE INDEX IF NOT EXISTS push_deliveries_created_idx
  ON push_deliveries (created_at);

-- ── Tenant isolation and direct-API lockout ─────────────────────────────────
-- Supabase exposes new public tables to the PostgREST roles by default. Both
-- tables are reachable only through the Express backend, which connects as the
-- table owner (BYPASSRLS) and filters by the authenticated user and tenant.
-- These statements close the direct-API path; they do not change app queries.
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON device_tokens FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON device_tokens;
CREATE POLICY deny_all_direct_access ON device_tokens
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON device_tokens;
CREATE POLICY tenant_isolation ON device_tokens FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON device_tokens TO app_tenant;

ALTER TABLE push_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_deliveries FROM anon, authenticated;
-- No tenant column: there is no row policy to write, and RLS with no policy
-- denies app_tenant by default. The explicit revoke keeps the intent visible.
-- The push sender stays on the owner/service-role backend connection; the
-- app_tenant role has no access to this table.
REVOKE ALL ON push_deliveries FROM app_tenant;
DROP POLICY IF EXISTS deny_all_direct_access ON push_deliveries;
CREATE POLICY deny_all_direct_access ON push_deliveries
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- Push preference, mirroring email_opt_out / whatsapp_opt_out (migration 226).
-- Transactional types still bypass it, as they do on the other channels.
ALTER TABLE pt_clients
  ADD COLUMN IF NOT EXISTS push_opt_out BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON TABLE device_tokens IS
  'FCM registration tokens. Ownership is always the authenticated session, never the request body. Sending filters by user_id AND organization_id.';
COMMENT ON TABLE push_deliveries IS
  'Per-job, per-token delivery ledger. Keeps a retried BullMQ job from alerting a device that already accepted the message.';
