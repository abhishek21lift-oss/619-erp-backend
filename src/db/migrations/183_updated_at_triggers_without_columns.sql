-- ============================================================================
-- 183_updated_at_triggers_without_columns.sql
--
-- Three tables carry a BEFORE UPDATE trigger that writes to a column they do
-- not have, so every UPDATE against them raises. Not "under some conditions" —
-- every UPDATE, by every role, including the table owner:
--
--   ERROR:  record "new" has no field "updated_at"
--   CONTEXT:  PL/pgSQL assignment "NEW.updated_at := NOW()"
--
-- ── Where it came from ──────────────────────────────────────────────────────
--
-- Migration 015 (lines 299-317) attaches trg_<t>_updated_at to a list of
-- fourteen table names in a loop. The loop checks whether the TRIGGER already
-- exists. It never checks whether the table has an updated_at COLUMN. Eleven of
-- the fourteen did. Three did not, and have been raising ever since:
--
--   bookings        class bookings — cancel and check-in are UPDATEs
--   body_metrics    a member's measurements, edited after a re-weigh
--   weight_logs     the same for weight
--
-- ── Verified, not inferred ──────────────────────────────────────────────────
--
-- Against a database built from schema.sql plus every migration:
--
--   UPDATE bookings SET status='cancelled' WHERE id='…';
--   ERROR:  record "new" has no field "updated_at"
--
-- And against the live database on 26 Aug 2026, joining pg_trigger to
-- information_schema.columns: of the 37 tables carrying this trigger, exactly
-- these three lack the column. Production has the same defect.
--
-- ── Why add the column rather than drop the trigger ─────────────────────────
--
-- 015's intent is not ambiguous: it wanted these rows to carry a last-modified
-- timestamp, and eleven of its fourteen tables got one. Dropping the trigger
-- would settle for less than was intended and would silently diverge these
-- three from every sibling table. Adding the column is also the additive
-- change: nothing that reads these tables today can break by gaining a column,
-- whereas anything that has learned to expect the timestamp on its siblings
-- keeps working.
--
-- DEFAULT NOW() rather than NULL so existing rows carry a value that is at
-- least ordered consistently with their creation, and NOT NULL so the trigger's
-- contract holds from the first UPDATE.
--
-- ── Relationship to 182 ─────────────────────────────────────────────────────
--
-- 182 made the bookings module's SQL executable against the bookings table.
-- This one makes the table writable at all. Both are required before a booking
-- can be cancelled or checked in; 182 alone would have exchanged one error for
-- another. Found by the two-tenant isolation proof, which cancels a booking as
-- part of proving one studio cannot cancel another's.
-- ============================================================================

-- ── 1. The three columns ─────────────────────────────────────────────────────
ALTER TABLE bookings     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE body_metrics ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE weight_logs  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ── 2. Report any table 015's mistake is repeated on ────────────────────────
-- The list above is the state on 26 Aug 2026. A future migration that adds the
-- trigger to a new table the same way would reintroduce exactly this bug, and
-- the symptom — one module's writes failing — is easy to read as that module's
-- fault. Warn instead of failing: a migration that refuses to boot the app over
-- a table it did not touch is a worse outcome than a loud log line.
DO $$
DECLARE
  broken TEXT[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname) INTO broken
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal
     AND n.nspname = 'public'
     AND p.proname = 'set_updated_at'
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'updated_at');

  IF broken IS NULL THEN
    RAISE NOTICE '183: every set_updated_at trigger now has an updated_at column to write to.';
  ELSE
    RAISE WARNING '183: these tables still carry a set_updated_at trigger with no updated_at column, so every UPDATE against them will raise: %',
      array_to_string(broken, ', ');
  END IF;
END $$;
