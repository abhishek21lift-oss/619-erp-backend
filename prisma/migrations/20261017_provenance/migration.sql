-- Phase 2 — Assessment provenance + norm-reference (nullable, backward-compatible)
-- Source: REDESIGN_PROMPT §19-26 / DESIGN_PHASE2.md §C / F-01 / F-05 / traceability 7/16/23
-- Status: ADDED for Phase 2; no norm VALUES changed; professional gate required before any norm edit
-- Rollback: DROP new columns / reference table; restore pre-Phase-2 assessment outputs (values unchanged)
-- Clinical / IP / legal gates: norm sources must be reviewed by qualified professional + source owner BEFORE suppression or approval markers set (F-05). This migration only creates fields.

ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS protocol_bundle_version VARCHAR(32);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS skip_reason VARCHAR(255);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS conditions TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS source_provenance VARCHAR(255);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS computed_at TIMESTAMP WITH TIME ZONE;

CREATE TABLE IF NOT EXISTS fitness_norm_sources (
  id SERIAL PRIMARY KEY,
  category VARCHAR(32) NOT NULL, -- vo2max | strength | endurance | flexibility | bp | bmi | whr
  source_name VARCHAR(255),
  source_licence VARCHAR(255),
  cohort VARCHAR(255),
  version VARCHAR(32),
  approved_by_review VARCHAR(255),
  approval_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS norm_source_id INTEGER REFERENCES fitness_norm_sources(id) ON DELETE SET NULL;
