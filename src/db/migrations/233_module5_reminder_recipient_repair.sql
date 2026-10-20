-- ── Module 5 reminder recipient repair ─────────────────────
-- An earlier draft of 231 created progress_reminder_deliveries with a
-- four-column UNIQUE key and no recipient. Databases that recorded that draft
-- will not re-run 231, so repair the shape forward here. Fresh databases get a
-- harmless no-op after the corrected 231.

ALTER TABLE progress_reminder_deliveries
  ADD COLUMN IF NOT EXISTS recipient TEXT NOT NULL DEFAULT 'client';

-- Drop the earlier draft's four-column uniqueness by its shape. A name-based
-- DROP is unsafe: the auto-generated constraint name is truncated at 63 bytes
-- and differs from the explicit name used by 231.
DO $$
DECLARE
  old_cols smallint[];
  old_obj record;
BEGIN
  SELECT array_agg(attnum ORDER BY attnum) INTO old_cols
    FROM pg_attribute
   WHERE attrelid = 'public.progress_reminder_deliveries'::regclass
     AND attname IN ('schedule_id', 'kind', 'stage_days', 'due_date');

  FOR old_obj IN
    SELECT conname AS name, 'constraint' AS kind
      FROM pg_constraint
     WHERE conrelid = 'public.progress_reminder_deliveries'::regclass
       AND contype = 'u'
       AND (SELECT array_agg(k ORDER BY k) FROM unnest(conkey) k) = old_cols
    UNION ALL
    SELECT c.relname AS name, 'index' AS kind
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.progress_reminder_deliveries'::regclass
       AND i.indisunique
       AND NOT i.indisprimary
       AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
       AND (SELECT array_agg(k ORDER BY k) FROM unnest(i.indkey::smallint[]) k) = old_cols
  LOOP
    IF old_obj.kind = 'constraint' THEN
      EXECUTE format('ALTER TABLE public.progress_reminder_deliveries DROP CONSTRAINT %I', old_obj.name);
    ELSE
      EXECUTE format('DROP INDEX public.%I', old_obj.name);
    END IF;
  END LOOP;
END $$;

ALTER TABLE progress_reminder_deliveries
  DROP CONSTRAINT IF EXISTS progress_reminder_deliveries_recipient_check;
ALTER TABLE progress_reminder_deliveries
  ADD CONSTRAINT progress_reminder_deliveries_recipient_check
  CHECK (recipient IN ('client','trainer'));

-- Recreate by name so a wrong-shaped index left by an earlier draft cannot
-- survive IF NOT EXISTS.
DROP INDEX IF EXISTS public.progress_reminder_delivery_recipient_key;
CREATE UNIQUE INDEX progress_reminder_delivery_recipient_key
  ON progress_reminder_deliveries (schedule_id, kind, stage_days, due_date, recipient);
