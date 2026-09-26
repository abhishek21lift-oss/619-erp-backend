-- 211_client_messages.sql
--
-- Member ↔ studio messaging: one conversation per client, between the member
-- and their studio.
--
-- ── Why a table of its own ─────────────────────────────────────────────────
--
-- `notifications` is one-way and per user; `communication_logs` records what
-- the studio sent out over WhatsApp; `support_ticket_messages` is the studio
-- talking to the PLATFORM. None of them is a two-way thread between a member
-- and their trainer, and bending one into it would mean a member's private
-- message sitting in a table other features read and report on.
--
-- ── Shape ──────────────────────────────────────────────────────────────────
--
-- One row per message. The thread is (organization_id, client_id): with one
-- trainer per studio (migration 208) the studio side of the conversation is
-- that trainer, so there is no separate "conversation" row to keep in step.
-- `sender` says which side wrote it; `sender_user_id` says who, and survives
-- the account being deleted as NULL rather than losing the message.
--
-- `read_at` is set when the OTHER side opens the thread. It is the whole of
-- the unread model: unread for the trainer = member messages with no read_at,
-- and the other way round for the member.
--
-- ── Measured before writing (production, 2026-09-26) ───────────────────────
--
--   No existing member ↔ trainer messaging of any kind. 35 clients, one
--   trainer login per studio, member logins being activated now.
--
-- No BEGIN/COMMIT — migrate.js wraps this together with the _migrations insert
-- that records it. See migrations.transactionControl.test.js.

CREATE TABLE IF NOT EXISTS client_messages (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id        TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  sender           TEXT NOT NULL CHECK (sender IN ('member', 'studio')),
  sender_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Trimmed by the API; the check is the backstop for anything that is not.
  body             TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  read_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The thread, newest first — every read of a conversation.
CREATE INDEX IF NOT EXISTS client_messages_thread_idx
  ON client_messages (organization_id, client_id, created_at DESC);

-- Unread counts: the trainer's inbox badge and the member's.
CREATE INDEX IF NOT EXISTS client_messages_unread_idx
  ON client_messages (organization_id, sender, client_id)
  WHERE read_at IS NULL;

-- ── RLS: both halves, for the reason 199 gives ─────────────────────────────
--
-- deny-all keeps the table off PostgREST with the publishable key; the
-- tenant_isolation policy and GRANT are what let the API (app_tenant) use it
-- at all. Strict form: every row is written by a request that has an org.
ALTER TABLE client_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_messages FROM anon, authenticated;

DROP POLICY IF EXISTS deny_all_direct_access ON client_messages;
CREATE POLICY deny_all_direct_access ON client_messages
  FOR ALL USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS tenant_isolation ON client_messages;
CREATE POLICY tenant_isolation ON client_messages FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON client_messages TO app_tenant;

COMMENT ON TABLE client_messages IS
  'Member ↔ studio messages, one thread per client. sender is the side that '
  'wrote it; read_at is set when the other side opens the thread.';

-- ── Verification ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'client_messages'
       AND policyname = 'tenant_isolation' AND 'app_tenant' = ANY(roles)
  ) THEN
    RAISE EXCEPTION '211: tenant_isolation policy for app_tenant is missing — messaging would be unwritable';
  END IF;

  IF NOT has_table_privilege('app_tenant', 'client_messages', 'INSERT') THEN
    RAISE EXCEPTION '211: app_tenant cannot INSERT — messaging would be unwritable';
  END IF;
END $$;
