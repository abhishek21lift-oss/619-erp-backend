-- Nutrition planning inputs the diet engine actually computes with.
--
-- Until now the generator inferred the dietary pattern from free-text
-- preferences and had no idea what food culture the client eats in, so every
-- Indian client got a plan that was half Western and every vegetarian's
-- pattern was a guess. These four columns are answered on the assessment form
-- (see the nutrition-assessment page) and read by
-- modules/nutrition/diet-facts.js.

ALTER TABLE pt_nutrition_assessments
  ADD COLUMN IF NOT EXISTS dietary_pattern TEXT
    CHECK (dietary_pattern IS NULL OR dietary_pattern IN
      ('vegetarian','eggetarian','non_vegetarian','vegan')),
  ADD COLUMN IF NOT EXISTS food_culture TEXT
    CHECK (food_culture IS NULL OR food_culture IN ('indian','western','mixed')),
  ADD COLUMN IF NOT EXISTS regional_cuisines TEXT[],
  ADD COLUMN IF NOT EXISTS meal_timing_preference TEXT
    CHECK (meal_timing_preference IS NULL OR meal_timing_preference IN
      ('early','standard','late','no_preference'));

-- Only unambiguous values are backfilled. 'Jain', 'Keto' and 'Mixed' classify
-- to nothing on purpose: unknown is not non-vegetarian, and silently deciding
-- a client eats meat would be worse than asking again.
UPDATE pt_nutrition_assessments
   SET dietary_pattern = CASE
     WHEN EXISTS (SELECT 1 FROM unnest(diet_preferences) p WHERE lower(trim(p)) = 'vegan') THEN 'vegan'
     WHEN EXISTS (SELECT 1 FROM unnest(diet_preferences) p WHERE lower(trim(p)) = 'vegetarian') THEN 'vegetarian'
     WHEN EXISTS (SELECT 1 FROM unnest(diet_preferences) p WHERE lower(trim(p)) IN ('eggetarian','eggitarian')) THEN 'eggetarian'
     WHEN EXISTS (SELECT 1 FROM unnest(diet_preferences) p WHERE lower(trim(p)) IN ('non-vegetarian','non vegetarian','non_vegetarian')) THEN 'non_vegetarian'
   END
 WHERE dietary_pattern IS NULL
   AND diet_preferences IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(diet_preferences) p
                WHERE lower(trim(p)) IN ('vegan','vegetarian','eggetarian','eggitarian',
                                         'non-vegetarian','non vegetarian','non_vegetarian'));
