-- 293_whatsapp_inbox.sql
--
-- One thread, two channels. `client_messages` already carried the member <->
-- studio conversation; WhatsApp inbound and outbound join it rather than
-- creating a second inbox, so the trainer reads one history and the member
-- sees one conversation whichever door they used.
--
-- `external_id` is the provider's message id. The partial unique index makes
-- at-least-once delivery safe: a duplicate insert loses the race and inserts
-- nothing, even when the gateway retries under a new event id.
--
-- `delivery_status` is NULL for in-app rows on purpose. An in-app message has
-- no transport to report on, and `sent` would claim a fact nobody observed.
-- `read_at` stays what it always was (the other side opened the thread);
-- `provider_read_at` is a WhatsApp read receipt, a different fact.
--
-- `whatsapp_unmatched_messages` is the retention path for a number the studio
-- cannot resolve, or resolves to more than one client. Dropping those messages
-- would make "why did nobody answer?" unanswerable; guessing a client would be
-- worse. RLS matches migration 211: no direct access, tenant isolation for the
-- application role.
--
-- Rollback (drops the unmatched inbox and the WhatsApp columns; no thread rows
-- are deleted, and in-app rows keep their data):
--   DROP TABLE IF EXISTS public.whatsapp_unmatched_messages;
--   DROP INDEX IF EXISTS public.client_messages_channel_idx;
--   DROP INDEX IF EXISTS public.client_messages_external_idx;
--   ALTER TABLE public.client_messages
--     DROP CONSTRAINT IF EXISTS client_messages_delivery_status_check,
--     DROP CONSTRAINT IF EXISTS client_messages_message_type_check,
--     DROP CONSTRAINT IF EXISTS client_messages_channel_check,
--     DROP COLUMN IF EXISTS failure_reason,
--     DROP COLUMN IF EXISTS provider_read_at,
--     DROP COLUMN IF EXISTS delivered_at,
--     DROP COLUMN IF EXISTS delivery_status,
--     DROP COLUMN IF EXISTS external_id,
--     DROP COLUMN IF EXISTS message_type,
--     DROP COLUMN IF EXISTS channel;

ALTER TABLE public.client_messages
  ADD COLUMN IF NOT EXISTS channel          TEXT NOT NULL DEFAULT 'in_app',
  ADD COLUMN IF NOT EXISTS message_type     TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS external_id      TEXT,
  ADD COLUMN IF NOT EXISTS delivery_status  TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_reason   TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'client_messages_channel_check'
                    AND conrelid = 'public.client_messages'::regclass) THEN
    ALTER TABLE public.client_messages
      ADD CONSTRAINT client_messages_channel_check
      CHECK (channel IN ('in_app','whatsapp'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'client_messages_message_type_check'
                    AND conrelid = 'public.client_messages'::regclass) THEN
    ALTER TABLE public.client_messages
      ADD CONSTRAINT client_messages_message_type_check
      CHECK (message_type IN ('text','image','video','audio','document','sticker','location','contact','other'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'client_messages_delivery_status_check'
                    AND conrelid = 'public.client_messages'::regclass) THEN
    ALTER TABLE public.client_messages
      ADD CONSTRAINT client_messages_delivery_status_check
      CHECK (delivery_status IS NULL OR delivery_status IN ('queued','sent','delivered','read','failed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS client_messages_external_idx
  ON public.client_messages (organization_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS client_messages_channel_idx
  ON public.client_messages (organization_id, channel, created_at DESC);

CREATE TABLE IF NOT EXISTS public.whatsapp_unmatched_messages (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  from_phone          TEXT NOT NULL,
  push_name           TEXT,
  message_type        TEXT NOT NULL DEFAULT 'text'
                      CHECK (message_type IN ('text','image','video','audio','document','sticker','location','contact','other')),
  body                TEXT,
  received_at         TIMESTAMPTZ NOT NULL,
  reason              TEXT NOT NULL CHECK (reason IN ('unknown_phone','ambiguous_phone')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, provider_message_id)
);

ALTER TABLE public.whatsapp_unmatched_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_unmatched_messages FROM anon, authenticated;

DROP POLICY IF EXISTS deny_all_direct_access ON public.whatsapp_unmatched_messages;
CREATE POLICY deny_all_direct_access ON public.whatsapp_unmatched_messages
  FOR ALL USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS tenant_isolation ON public.whatsapp_unmatched_messages;
CREATE POLICY tenant_isolation ON public.whatsapp_unmatched_messages FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_unmatched_messages TO app_tenant;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'whatsapp_unmatched_messages'
       AND policyname = 'tenant_isolation' AND 'app_tenant' = ANY(roles)
  ) THEN
    RAISE EXCEPTION '293: tenant_isolation policy for app_tenant is missing — unmatched inbound would be unwritable';
  END IF;

  IF NOT has_table_privilege('app_tenant', 'public.whatsapp_unmatched_messages', 'INSERT') THEN
    RAISE EXCEPTION '293: app_tenant cannot INSERT — unmatched inbound would be unwritable';
  END IF;
END $$;
