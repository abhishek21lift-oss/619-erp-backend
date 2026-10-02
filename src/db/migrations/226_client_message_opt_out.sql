-- ─────────────────────────────────────────────────────────────────────────
-- 226 — A client can opt out of automated messages, per channel
-- ─────────────────────────────────────────────────────────────────────────
--
-- Automation (birthday, expiry and payment-due reminders, follow-ups) and the
-- studio broadcast messaged every client with a number, and there was no way
-- to record that a client had asked them to stop.
--
--   pt_clients.whatsapp_opt_out / email_opt_out
--       Set when the client asks the studio to stop that channel. An opt-out
--       stops reminders and promotional messages; a payment receipt the client
--       is owed still goes (studio decision, Phase 2, 2026-10-02).
--   pt_clients.comm_prefs_updated_at / comm_prefs_updated_by
--       When the preference last changed and which account recorded it; the
--       full history is in activity_log (client.update).
--
--   communication_logs.status gains 'suppressed'
--       A message the opt-out stopped is still written, with the reason in
--       failure_reason, so the studio can see it was deliberately not sent and
--       the dedupe key stops it being re-evaluated. The constraint is replaced
--       by a SUPERSET of the old one, so every existing row stays valid.
--
-- Additive and backward compatible: both flags default to FALSE, i.e. nobody
-- is opted out until somebody records that they are. No existing data changes.

ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS whatsapp_opt_out BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS email_opt_out BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS comm_prefs_updated_at TIMESTAMPTZ;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS comm_prefs_updated_by TEXT;

ALTER TABLE communication_logs DROP CONSTRAINT IF EXISTS communication_logs_status_check;
ALTER TABLE communication_logs ADD CONSTRAINT communication_logs_status_check
  CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'bounced', 'suppressed'));
