-- ============================================================
-- 235_vitals_classification.sql
-- Persists the resting vitals classifications that the fitness-testing
-- module already computes, plus the exercise-safety decision made at the
-- time of the test. Raw values stay the source of truth; these columns are
-- derived and are recomputed on every create/edit.
--
-- Existing rows keep NULL, which the UI treats as "not classified" rather
-- than inventing a category from a single old reading.
-- ============================================================

ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS rhr_category   TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS spo2_category  TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS vitals_safety  TEXT;
