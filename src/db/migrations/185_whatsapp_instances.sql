-- 185_whatsapp_instances.sql
--
-- The studio-facing record of a self-hosted WhatsApp connection, plus the
-- idempotency ledger for the gateway's webhook.
--
-- ── What is deliberately NOT here ───────────────────────────────────────────
--
-- No whatsapp_messages table. communication_logs (migration 012) already models
-- a message stream — direction, the exact status vocabulary
-- ('queued','sent','delivered','read','failed','bounced'), external_id for the
-- provider's id, and 'whatsapp' already in its channel CHECK. A parallel table
-- would split message history across two schemas and every report that reads it.
--
-- No whatsapp_contacts table. pt_clients.whatsapp (migration 052) is already the
-- tenant's contact record.
--
-- No session or credential columns. Baileys auth state lives on the gateway's
-- own volume and never reaches this database — see the gateway repo's
-- docs/WHATSAPP-ARCHITECTURE.md §12.1. The gateway holds no database
-- credentials at all, which is the point: it has the largest third-party
-- dependency tree in the stack and speaks an unofficial protocol.

-- ── The business record ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_instances (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The id the GATEWAY knows this instance by. Minted here rather than there so
  -- that a create whose response is lost in flight still leaves us able to
  -- address the instance — otherwise a live socket would exist that nothing
  -- could reach.
  instance_id      UUID NOT NULL UNIQUE,

  status           TEXT NOT NULL DEFAULT 'never_connected'
                   CHECK (status IN ('never_connected','connecting','connected',
                                     'disconnected','reconnecting','logged_out',
                                     'qr_timeout','failed')),

  -- Present only once WhatsApp reported it, and it may legitimately stay NULL:
  -- Baileys 7 often identifies an account by LID rather than phone number, and
  -- showing a LID next to "Connected" would look like a corrupted number.
  phone_e164       TEXT,

  -- The last gateway reason code, for support. Never a raw error string.
  last_error_code  TEXT,

  connected_at     TIMESTAMPTZ,
  disconnected_at  TIMESTAMPTZ,
  last_event_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One WhatsApp connection per studio in the MVP. The product UX is "Connect
  -- WhatsApp", singular, and this constraint is the cheapest way to make
  -- "which instance did they mean?" un-askable. instance_id is a separate
  -- column precisely so lifting this later is a migration, not a redesign.
  CONSTRAINT whatsapp_instances_one_per_org UNIQUE (organization_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_org
  ON whatsapp_instances (organization_id);

-- ── Webhook idempotency ledger ──────────────────────────────────────────────
--
-- The gateway delivers at-least-once (its outbox retries on any non-2xx, and a
-- crash between delivery and acknowledgement replays), so duplicates are NORMAL
-- rather than exceptional. Without this ledger a redelivered `disconnected`
-- would overwrite a `connected` that arrived after it, and the card would show
-- a studio as offline when it is not.
CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  event_id         UUID PRIMARY KEY,
  event_type       TEXT NOT NULL,
  organization_id  UUID REFERENCES organizations(id) ON DELETE CASCADE,
  instance_id      UUID,
  occurred_at      TIMESTAMPTZ NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supports the retention sweep; the PK already covers the duplicate lookup.
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_received
  ON whatsapp_webhook_events (received_at DESC);

-- ── Row Level Security ──────────────────────────────────────────────────────
--
-- Two layers, and the repo's convention (from 104 onwards, enforced by
-- src/__tests__/rls.convention.test.js) requires BOTH to name the table
-- explicitly rather than rely on the discovery sweep further down:
--
--   1. ENABLE RLS + a deny-all policy — nothing reaches these rows except
--      through a role with a policy that says otherwise.
--   2. REVOKE from anon and authenticated — defence in depth. RLS alone would
--      deny, but this is the layer that survives someone adding a permissive
--      policy later for one legitimate case and accidentally widening the
--      table. That is not hypothetical here: finding C-01 was fifteen tables
--      with RLS off while `anon` held SELECT and INSERT, each omission
--      individually plausible in review.
--
-- These tables are reachable through PostgREST with the publishable key if this
-- is forgotten, which would bypass the API and every tenant check in it.
-- whatsapp_instances exposes which studios have WhatsApp connected and their
-- phone numbers.

ALTER TABLE whatsapp_instances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_instances FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON whatsapp_instances;
CREATE POLICY deny_all_direct_access ON whatsapp_instances
  FOR ALL USING (false) WITH CHECK (false);

ALTER TABLE whatsapp_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_webhook_events FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON whatsapp_webhook_events;
CREATE POLICY deny_all_direct_access ON whatsapp_webhook_events
  FOR ALL USING (false) WITH CHECK (false);

-- Then re-run migration 157/158's discovery block, which attaches the
-- `tenant_isolation` policy to EVERY table carrying organization_id. That is
-- what actually grants app_tenant its scoped access, and running it here means
-- these two tables get the same rule as the rest of the schema rather than a
-- hand-written copy that could drift out of sync with it.
--
-- Idempotent by construction: ENABLE ROW LEVEL SECURITY and DROP POLICY IF
-- EXISTS both tolerate re-running, so tables 157/158 already covered are
-- untouched no-ops.
DO $$
DECLARE
  tbl text;
  shared_tables text[] := ARRAY[
    'exercises', 'diet_templates', 'muscle_volume_landmarks', 'login_events',
    'users', 'workout_plans', 'storage_objects', 'user_webauthn_credentials'
  ];
BEGIN
  FOR tbl IN
    SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'organization_id'
       AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
    IF tbl = ANY(shared_tables) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant ' ||
        'USING (organization_id::text = current_setting(''app.org_id'', true) OR organization_id IS NULL) ' ||
        'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true) OR organization_id IS NULL)',
        tbl
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant ' ||
        'USING (organization_id::text = current_setting(''app.org_id'', true)) ' ||
        'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))',
        tbl
      );
    END IF;
  END LOOP;
END $$;
