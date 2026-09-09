-- 190_whatsapp_automation_permission.sql
--
-- Explicit, per-studio permission for automated WhatsApp sending, plus the
-- per-trainer grant that makes "on whose behalf" answerable.
--
-- ── Why not system_settings, where the permission matrix already lives ──────
--
-- Because system_settings has no organization_id. Verified against production
-- rather than assumed: the column does not exist, the table holds 35 rows for
-- 6 studios, and routes/settings.js writes it with ON CONFLICT (key). One
-- studio switching "trainers may send WhatsApp" on would switch it on for
-- every studio on the platform.
--
-- That is a known gap with a fix already written elsewhere (the migration that
-- tenants system_settings and attributes its existing rows), and this change
-- deliberately does not pull it in. Automated messages leave the building and
-- cannot be recalled; hanging their authorisation off a table that is
-- currently global would mean the permission is only as correct as a migration
-- that has not landed. These tables are tenanted from their first row instead.
--
-- ── Two levels, because the question has two halves ─────────────────────────
--
--   1. Does this STUDIO allow automated sending at all?  (whatsapp_automation_settings)
--   2. May a message go out on behalf of THIS TRAINER?    (whatsapp_automation_trainer_grants)
--
-- Both must say yes. The studio switch is what an owner reaches for when
-- something is wrong and they want it all to stop; the grant is what makes an
-- individual trainer's messages attributable and revocable without taking the
-- whole studio down.
--
-- Both default to CLOSED. A studio that has never visited the setting sends
-- nothing, which is the only safe default for a channel where the failure mode
-- is messaging real clients.

-- ── The studio switch ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_automation_settings (
  organization_id     UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,

  -- FALSE, deliberately. Migration 012 created automation_rules with
  -- is_active DEFAULT TRUE and nothing ever executed them, so production holds
  -- rules that have never fired. Defaulting this to TRUE would make every one
  -- of them live on the deploy that introduces the engine — a studio's clients
  -- receiving months of backlogged automation in one burst.
  automation_enabled  BOOLEAN NOT NULL DEFAULT FALSE,

  -- A studio-wide ceiling on automated messages per day. Not a billing
  -- control: it is the blast radius of a rule written with a trigger that
  -- fires more often than its author expected, which is the most likely way
  -- this feature goes wrong in its first month.
  daily_send_limit    INT NOT NULL DEFAULT 200 CHECK (daily_send_limit > 0),

  updated_by          TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── The per-trainer grant ───────────────────────────────────────────────────
--
-- A row means "automated messages may be sent on this trainer's behalf". The
-- absence of a row means no, so revoking is a DELETE and there is no third
-- state to reason about.
--
-- trainer_id references `trainers`, not `pt_trainers`. Migration 145 already
-- repointed the commission foreign keys the same way, for the same reason:
-- every trainer this product creates lands in `trainers`, and there is no
-- INSERT INTO pt_trainers anywhere in the codebase.
CREATE TABLE IF NOT EXISTS whatsapp_automation_trainer_grants (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  trainer_id       TEXT NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,

  granted_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The org is part of the key, not merely a column. A trainer id is unique on
  -- its own, so (organization_id, trainer_id) looks redundant — it is not:
  -- it makes every read of this table naturally org-scoped, so a query that
  -- forgets the tenant filter still cannot match another studio's grant by
  -- trainer id alone.
  CONSTRAINT whatsapp_automation_grant_unique UNIQUE (organization_id, trainer_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_automation_grants_org
  ON whatsapp_automation_trainer_grants (organization_id);

-- ── What communication_logs still lacked ────────────────────────────────────
--
-- The table is otherwise already the right shape for this: status already
-- reads 'queued','sent','delivered','read','failed','bounced', external_id is
-- already there for the provider's message id, sent_at / delivered_at /
-- read_at are already separate columns, and automation_rule_id already links a
-- message back to the rule that produced it. It has simply never been written
-- to — 0 rows in production, because nothing ever executed a rule.
--
-- Three columns are missing, and each is load-bearing rather than nice to have.

-- Which provider carried it. Without this a row cannot answer "did this go out
-- on the studio's own number or a shared one?", which is the single most
-- important fact about an automated message after whether it arrived.
ALTER TABLE communication_logs ADD COLUMN IF NOT EXISTS provider TEXT;

-- Why a failed row failed. status='failed' with no reason forces an operator
-- into the worker's logs to distinguish "their WhatsApp is disconnected" from
-- "the number was invalid" — the first is the studio's to fix and the second
-- is the data's.
ALTER TABLE communication_logs ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- The idempotency key for BUSINESS events, which is a different problem from
-- the gateway's send-once.
--
-- The gateway stops one message being DELIVERED twice. This stops one event
-- being QUEUED twice — a webhook redelivering a payment, a sweep overlapping
-- its previous run, a retried request that already ran its side effects. Those
-- produce a second, legitimate-looking call into the engine with a fresh
-- message id, which send-once downstream cannot recognise as a duplicate
-- because it genuinely is a different message.
--
-- Composed from the rule and the business object it fired for, so the same
-- payment cannot produce two reminders under one rule while a DIFFERENT rule
-- on the same payment still can.
ALTER TABLE communication_logs ADD COLUMN IF NOT EXISTS automation_dedupe_key TEXT;

-- Partial and org-scoped. Two studios can hold the same key — their ids come
-- from separate tables — and the constraint must not make one studio's
-- automation collide with another's.
CREATE UNIQUE INDEX IF NOT EXISTS ux_communication_logs_dedupe
  ON communication_logs (organization_id, automation_dedupe_key)
  WHERE automation_dedupe_key IS NOT NULL;

-- ── Correlating delivery receipts ───────────────────────────────────────────
--
-- The gateway's message.delivered / message.read events are keyed by the
-- provider's message id, which the ERP stored in communication_logs.external_id
-- when it recorded the send. Every receipt is therefore a lookup on that
-- column, and without an index it is a sequential scan of a table that grows
-- with every message the platform ever sends.
--
-- Partial, because only outgoing rows ever carry one.
CREATE INDEX IF NOT EXISTS idx_communication_logs_external_id
  ON communication_logs (external_id)
  WHERE external_id IS NOT NULL;

-- Supports the daily send limit, which counts today's rows for one studio.
CREATE INDEX IF NOT EXISTS idx_communication_logs_org_created
  ON communication_logs (organization_id, created_at DESC);

-- ── Row Level Security ──────────────────────────────────────────────────────
--
-- Both layers, named explicitly, as src/__tests__/rls.convention.test.js
-- requires from migration 104 onwards: a deny-all policy so nothing reaches
-- these rows except through a role with a policy saying otherwise, and a
-- REVOKE from anon/authenticated so the tables are not reachable through
-- PostgREST with the publishable key.
--
-- These two carry more than a preference. whatsapp_automation_trainer_grants
-- is the answer to "may this send happen", so a row written by the wrong
-- studio is an authorisation bypass, not a data leak.

ALTER TABLE whatsapp_automation_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_automation_settings FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON whatsapp_automation_settings;
CREATE POLICY deny_all_direct_access ON whatsapp_automation_settings
  FOR ALL USING (false) WITH CHECK (false);

ALTER TABLE whatsapp_automation_trainer_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_automation_trainer_grants FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON whatsapp_automation_trainer_grants;
CREATE POLICY deny_all_direct_access ON whatsapp_automation_trainer_grants
  FOR ALL USING (false) WITH CHECK (false);

-- The tenant_isolation policy app_tenant actually reads through. Written
-- explicitly for these two rather than left to a discovery sweep, so the rule
-- is visible in the migration that creates the tables.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['whatsapp_automation_settings','whatsapp_automation_trainer_grants']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant '
      || 'USING (organization_id::text = current_setting(''app.org_id'', true)) '
      || 'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))',
      tbl
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_tenant', tbl);
  END LOOP;
END $$;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- A migration that silently half-applied is how a permission table ends up
-- with no policy on it. This block makes that outcome an error at apply time
-- rather than a discovery later.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['whatsapp_automation_settings','whatsapp_automation_trainer_grants']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_isolation policy missing on: %', missing;
  END IF;
END $$;
