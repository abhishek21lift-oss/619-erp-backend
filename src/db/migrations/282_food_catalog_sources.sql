-- ============================================================
-- 282_food_catalog_sources.sql
-- Extend the global foods reference with dataset provenance.
-- ============================================================
--
-- The seeded catalog in 280 came from a hand-curated list. The IFCT 2017
-- (542 foods) and INDB (1,014 recipes) imports need three fields the table
-- did not carry: where a row came from, its local-language names, and the
-- household measure a person actually eats ("1 katori", "1 bowl").
--
-- Column names stay in the table's existing vocabulary: `calories` is
-- already kcal, `fats_g` already holds total fat, and `serving_grams` is
-- already "grams per one serving unit" (100 for per-100 g datasets). Adding
-- parallel `calories_kcal` / `fat_g` columns would duplicate live data that
-- food-reference.js reads today.

ALTER TABLE foods
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'curated',
  ADD COLUMN IF NOT EXISTS local_names TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS household_serving TEXT;

-- Imported rows are per 100 g, so a new row that omits serving_grams is
-- still valid. Existing rows keep their explicit values.
ALTER TABLE foods ALTER COLUMN serving_grams SET DEFAULT 100;

CREATE INDEX IF NOT EXISTS foods_source_idx ON foods (source);
