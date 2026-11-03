-- Assignment lifecycle metadata.
--
-- `status` already promised active/completed/paused/cancelled (migration 197),
-- but nothing recorded WHEN or WHY an assignment stopped. A row that reads
-- `completed` with no timestamp cannot answer "when did this client finish
-- that block", and a row retired automatically by a new assignment is
-- indistinguishable from one a trainer ended on purpose.
--
-- Additive only. No row changes state here; `retired_at` is backfilled for
-- rows that already left `active`, from their last update, so historical
-- reporting has a timestamp instead of a null.

ALTER TABLE workout_assignments
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

ALTER TABLE workout_assignments
  ADD COLUMN IF NOT EXISTS retire_reason TEXT;

UPDATE workout_assignments
   SET retired_at = COALESCE(retired_at, updated_at, NOW())
 WHERE status <> 'active'
   AND retired_at IS NULL;

CREATE INDEX IF NOT EXISTS workout_assignments_retired_idx
  ON workout_assignments (client_id, retired_at DESC)
  WHERE status <> 'active';
