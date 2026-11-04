-- ─────────────────────────────────────────────────────────────────────────
-- 262 — Client Interview owns occupation, sport history and readiness
-- ─────────────────────────────────────────────────────────────────────────
--
-- Three intake answers the interview asks but never stored:
--
--   occupation_type        one of the eleven Lifestyle keys (056)
--   sports_participation   never / previously / currently
--   programme_readiness    1–10 self-rating
--
-- All optional: a skipped answer is NULL, never a guessed value.
--
-- Existing interviews get occupation_type from the client's latest Lifestyle
-- Assessment, so a coach opening an old interview sees the fact the client
-- already gave. Only the newest interview per client is touched (completed
-- beats draft), only when its own occupation_type is NULL, and updated_at is
-- deliberately left alone — this is a backfill, not an edit.
--
-- Additive and idempotent. No column or row is dropped or rewritten.
-- No BEGIN/COMMIT — migrate.js wraps this with the _migrations record.

ALTER TABLE pt_client_interviews
  ADD COLUMN IF NOT EXISTS occupation_type TEXT,
  ADD COLUMN IF NOT EXISTS sports_participation TEXT,
  ADD COLUMN IF NOT EXISTS programme_readiness SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_occupation_type_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_occupation_type_check
      CHECK (occupation_type IS NULL OR occupation_type IN (
        'desk_job','active_job','physical_labor','student','homemaker',
        'driver','healthcare','police','fitness_professional','retired','other'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_sports_participation_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_sports_participation_check
      CHECK (sports_participation IS NULL OR sports_participation IN (
        'never','previously','currently'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_client_interviews_programme_readiness_check'
       AND conrelid = 'pt_client_interviews'::regclass
  ) THEN
    ALTER TABLE pt_client_interviews
      ADD CONSTRAINT pt_client_interviews_programme_readiness_check
      CHECK (programme_readiness IS NULL OR programme_readiness BETWEEN 1 AND 10);
  END IF;
END $$;

WITH latest_interview AS (
  SELECT DISTINCT ON (client_id) id, client_id
  FROM pt_client_interviews
  ORDER BY client_id, (status = 'completed') DESC, created_at DESC
),
latest_lifestyle AS (
  SELECT DISTINCT ON (client_id) client_id, occupation_type
  FROM pt_lifestyle_assessments
  WHERE occupation_type IS NOT NULL
  ORDER BY client_id, assessment_date DESC, created_at DESC
)
UPDATE pt_client_interviews i
SET occupation_type = l.occupation_type
FROM latest_interview li
JOIN latest_lifestyle l ON l.client_id = li.client_id
WHERE i.id = li.id AND i.occupation_type IS NULL;

COMMENT ON COLUMN pt_client_interviews.occupation_type IS
  'Lifestyle occupation key; seeded from the latest Lifestyle Assessment when NULL.';
COMMENT ON COLUMN pt_client_interviews.sports_participation IS
  'never / previously / currently. NULL means not asked.';
COMMENT ON COLUMN pt_client_interviews.programme_readiness IS
  '1–10 self-rating of readiness for the programme. NULL means not asked.';
