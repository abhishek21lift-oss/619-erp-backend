-- 271 — Lifestyle Assessment becomes the canonical owner of sitting time and
-- meal regularity, which the Client Interview used to ask.
--
-- Additive only: the legacy pt_client_interviews columns stay readable so old
-- records and reports keep working. No existing data is rewritten or deleted.

ALTER TABLE pt_lifestyle_assessments
  ADD COLUMN IF NOT EXISTS sitting_hours NUMERIC(4,1)
    CHECK (sitting_hours IS NULL OR (sitting_hours >= 0 AND sitting_hours <= 24)),
  ADD COLUMN IF NOT EXISTS meal_regularity TEXT
    CHECK (meal_regularity IS NULL OR meal_regularity IN ('regular','irregular','inconsistent'));

COMMENT ON COLUMN pt_lifestyle_assessments.sitting_hours IS
  'Average hours spent sitting each day. Canonical owner is the Lifestyle Assessment; pt_client_interviews.lifestyle_sitting_hours is a legacy fallback.';
COMMENT ON COLUMN pt_lifestyle_assessments.meal_regularity IS
  'How often meals land at roughly the same time. Canonical owner is the Lifestyle Assessment; pt_client_interviews.lifestyle_meal_regularity and pt_nutrition_assessments.meal_timing_consistency are legacy fallbacks.';
