-- ─────────────────────────────────────────────────────────────────────────
-- 261 — Lifestyle assessment: mental health perception + stress management
-- ─────────────────────────────────────────────────────────────────────────
--
-- Two facts the assessment discusses but never stored:
--
--   mental_health_perception       1–10 self-rating
--   stress_management_techniques  fixed multi-select
--
-- Both are optional. A skipped answer is NULL, never a guessed value, and
-- neither field is an input to the Smart Lifestyle Analysis — no existing
-- score, risk badge or readiness label changes.
--
-- `none` is an answer, not a technique: it cannot sit beside another key.
-- The API rejects that combination; this CHECK is the backstop for any other
-- writer.
--
-- Additive and idempotent. No row is updated. No BEGIN/COMMIT — migrate.js
-- wraps this with the _migrations record.

ALTER TABLE pt_lifestyle_assessments
  ADD COLUMN IF NOT EXISTS mental_health_perception SMALLINT,
  ADD COLUMN IF NOT EXISTS stress_management_techniques TEXT[];

ALTER TABLE pt_lifestyle_assessments
  DROP CONSTRAINT IF EXISTS pt_lifestyle_assessments_mental_health_perception_check;
ALTER TABLE pt_lifestyle_assessments
  ADD CONSTRAINT pt_lifestyle_assessments_mental_health_perception_check
  CHECK (mental_health_perception IS NULL OR mental_health_perception BETWEEN 1 AND 10);

ALTER TABLE pt_lifestyle_assessments
  DROP CONSTRAINT IF EXISTS pt_lifestyle_assessments_stress_management_techniques_check;
ALTER TABLE pt_lifestyle_assessments
  ADD CONSTRAINT pt_lifestyle_assessments_stress_management_techniques_check
  CHECK (
    stress_management_techniques IS NULL OR (
      stress_management_techniques <@ ARRAY[
        'exercise', 'meditation', 'breathing', 'social_support', 'journaling',
        'therapy', 'hobbies', 'spirituality', 'medication', 'nature', 'none', 'other'
      ]::text[]
      AND NOT (
        'none' = ANY(stress_management_techniques)
        AND array_length(stress_management_techniques, 1) > 1
      )
    )
  );

COMMENT ON COLUMN pt_lifestyle_assessments.mental_health_perception IS
  '1–10 self-rating, 10 = very positive. Optional; not part of the lifestyle score.';
COMMENT ON COLUMN pt_lifestyle_assessments.stress_management_techniques IS
  'Fixed keys the client uses to manage stress. none is exclusive; NULL means not asked.';
