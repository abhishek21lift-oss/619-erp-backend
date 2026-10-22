-- ============================================================
-- 236_anthropometric_classification.sql
-- Persists the anthropometric classifications the fitness-testing module
-- computes: adult Asian BMI bands, plus the sex-specific low-risk waist and
-- waist-to-hip-ratio labels. Raw measurements stay the source of truth; these
-- columns are derived and are recomputed on every create/edit.
--
-- The waist classification is derived from waist_cm (the narrowest-waist
-- measurement used by the WHR formula), never from waist_iliac_cm.
--
-- Existing rows keep NULL, which the UI treats as "not classified" rather than
-- inventing a category from an old row whose current sex-specific norm cannot
-- be established here.
-- ============================================================

ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS bmi_category   TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS waist_risk     TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS whr_risk       TEXT;
