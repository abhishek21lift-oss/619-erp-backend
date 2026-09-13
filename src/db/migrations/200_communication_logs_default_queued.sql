-- communication_logs.status must not default to 'sent'.
--
-- ── What was there ─────────────────────────────────────────────────────────
--
-- Migration 012 created the table with:
--
--     status TEXT NOT NULL DEFAULT 'sent'
--
-- so any INSERT that omits the column asserts the message reached the client.
-- That is the one claim this system is not allowed to make without evidence: a
-- row reading 'sent' is what the studio sees on the client's timeline, what
-- the daily-limit counter bills against, and what tells the recovery sweep
-- there is nothing to re-drive.
--
-- ── Is it live today? No — and that is exactly why it is worth removing ────
--
-- Both statements that insert here write 'queued' explicitly
-- (automation.repository.js insertQueued and the advisory-locked variant), so
-- no current path relies on the default. Measured on production: 9 rows, 8
-- 'sent' each carrying an external_id and a sent_at from a real gateway
-- response, 1 'failed'. Nothing has been fabricated.
--
-- So this changes no behaviour. It removes a default that would make the next
-- INSERT — a campaign writer, a manual send, an AI action, a report send, all
-- of which the roadmap adds to this same table — silently claim delivery for a
-- message that had not left the building. The correct initial state for a
-- message nobody has tried to send yet is 'queued', and the schema should be
-- the thing that says so rather than every future author remembering to.
--
-- ── Why not NOT NULL with no default at all ────────────────────────────────
--
-- That would be stricter and it would break the two existing statements'
-- right to keep working unchanged if the column is ever dropped from their
-- column lists. 'queued' is the honest zero value: it is where every message
-- starts, it is re-drivable by automation.recovery, and it never asserts an
-- outcome. A wrong 'queued' costs a redundant send attempt; a wrong 'sent'
-- costs a message the studio believes was delivered and was not.

DO $$
BEGIN
  ALTER TABLE communication_logs ALTER COLUMN status SET DEFAULT 'queued';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'communication_logs.status default: %', SQLERRM;
END $$;

-- Prove it, rather than trusting the statement above ran. A migration that
-- silently no-ops inside its own exception handler is how the RLS policy in
-- 199 was nearly missed.
DO $$
DECLARE
  current_default TEXT;
BEGIN
  SELECT column_default INTO current_default
    FROM information_schema.columns
   WHERE table_name = 'communication_logs' AND column_name = 'status';

  IF current_default IS NULL OR current_default NOT LIKE '%queued%' THEN
    RAISE EXCEPTION
      'communication_logs.status still defaults to % — a message row must never begin life claiming it was sent',
      COALESCE(current_default, 'NULL');
  END IF;
END $$;
