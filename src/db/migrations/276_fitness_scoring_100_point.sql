-- 100-point fitness framework. Spec:
-- docs/superpowers/specs/2026-11-11-fitness-scoring-100-point-design.md
--
-- Additive and forward-only: the old application ignores the new columns, so a
-- code rollback needs no schema rollback. `overall_points` / `overall_max` are
-- stored because the denominator cannot be re-derived from the point columns
-- (a legitimate 0 is indistinguishable from "not measured", and 5 anthropometry
-- points could be 5/7 or 5/10).
ALTER TABLE pt_assessments
  ADD COLUMN IF NOT EXISTS scoring_formula_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS bp_points SMALLINT,
  ADD COLUMN IF NOT EXISTS anthropometric_points NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS overall_points NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS overall_max NUMERIC(5,1);

-- Battery steps award 7.5 per test, so the old integer columns need a decimal.
ALTER TABLE pt_assessments
  ALTER COLUMN strength_score_computed TYPE NUMERIC(4,1),
  ALTER COLUMN endurance_score_computed TYPE NUMERIC(4,1);
