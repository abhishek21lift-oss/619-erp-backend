-- ─────────────────────────────────────────────────────────────────────────
-- 240 — Training days is a whole week, not 3–6
-- ─────────────────────────────────────────────────────────────────────────
--
-- 228a bounded lifestyle_training_days to BETWEEN 3 AND 6. A client who can
-- train one day a week — or none while injured — could not be recorded: the
-- insert hit the CHECK and surfaced as a 500, not a validation error. The
-- service now validates the field first (0–7, whole days); this widens the
-- column to agree with it.
--
-- The old constraint was created inline and may carry an auto-generated name,
-- so it is found by the column it mentions rather than by guessing.
--
-- Idempotent; safe to re-run.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'pt_client_interviews'::regclass
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%lifestyle_training_days%'
  LOOP
    EXECUTE format('ALTER TABLE pt_client_interviews DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE pt_client_interviews
  ADD CONSTRAINT pt_client_interviews_lifestyle_training_days_check
  CHECK (lifestyle_training_days IS NULL OR lifestyle_training_days BETWEEN 0 AND 7);

COMMENT ON COLUMN pt_client_interviews.lifestyle_training_days IS 'Days a week the client can realistically train (0-7)';
