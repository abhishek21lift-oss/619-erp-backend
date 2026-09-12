-- ============================================================
-- 198_whatsapp_webhook_event_outcome.sql
-- Record what a webhook event REFERRED TO and what it CHANGED.
-- ============================================================
--
-- `whatsapp_webhook_events` is the idempotency ledger: one row per event the
-- gateway delivered, claimed inside the same transaction as the work it
-- authorises (#131). It answers "has this event been seen" perfectly, and
-- nothing else — it stores the event id, its type, the tenant, the instance
-- and two timestamps.
--
-- That turns out to be the difference between an answerable production
-- question and an unanswerable one. Measured on the live database:
--
--   whatsapp.message.sent        4 events      communication_logs: 4 rows 'sent'
--   whatsapp.message.delivered   6 events      communication_logs: 0 rows with
--                                              delivered_at set
--
-- Six delivery receipts arrived, were verified, were claimed, were answered
-- 200 — and not one row in the table they exist to update has a delivered_at.
-- There are two completely different explanations and the ledger cannot
-- separate them:
--
--   1. They were the studio's OWN hand-sent messages. The gateway forwards
--      receipts for every message the account sent, and `fromMe` is true for
--      a message the trainer typed on their phone just as it is for one the
--      ERP sent. Those legitimately match nothing. Four of the six landed at
--      18:06 on a day the ERP sent nothing at all, so at least those are this.
--
--   2. The provider id on the receipt does not match the external_id recorded
--      at send time, and every delivery receipt this product will ever
--      receive is being silently discarded.
--
-- Case 2 means the delivery state the studio was just given a UI for never
-- populates. Case 1 means it works and has had nothing to show yet. The
-- difference is one column, and without it the only way to tell them apart is
-- to send a real message to a real client and watch.
--
-- So: store the id the event referred to, and how many rows it changed. A
-- receipt that matched nothing then says so, permanently, next to the id it
-- was looking for — and the same row that proves the event was not replayed
-- proves whether it did anything.
--
-- ── Not a behaviour change ─────────────────────────────────────────────────
--
-- Both columns are nullable with no default and nothing reads them yet. The
-- eight historical event types already in the table keep NULL, which is the
-- honest value: nothing recorded it at the time.
--
-- No BEGIN/COMMIT — migrate.js wraps this together with the _migrations insert
-- that records it. See migrations.transactionControl.test.js.

ALTER TABLE whatsapp_webhook_events
  ADD COLUMN IF NOT EXISTS subject_key  TEXT,
  ADD COLUMN IF NOT EXISTS applied_rows INTEGER;

COMMENT ON COLUMN whatsapp_webhook_events.subject_key IS
  'The id this event referred to: provider_message_id for a delivered/read '
  'receipt, client_message_id (= communication_logs.id) for a send failure, '
  'the instance id for a connection event. NULL for rows written before '
  'migration 198.';

COMMENT ON COLUMN whatsapp_webhook_events.applied_rows IS
  'How many rows this event actually changed. 0 is a real and important value: '
  'a receipt that matched no message. NULL for rows written before migration '
  '198, and for event types this build does not act on.';

-- The question this exists to answer, asked the way an operator would ask it:
-- "did any receipt land on nothing?"
CREATE INDEX IF NOT EXISTS whatsapp_webhook_events_unmatched_idx
  ON whatsapp_webhook_events (organization_id, event_type, received_at DESC)
  WHERE applied_rows = 0;

DO $$
DECLARE total BIGINT;
BEGIN
  SELECT count(*) INTO total FROM whatsapp_webhook_events;
  RAISE NOTICE '198: % existing event(s) keep NULL subject_key / applied_rows', total;
END $$;
