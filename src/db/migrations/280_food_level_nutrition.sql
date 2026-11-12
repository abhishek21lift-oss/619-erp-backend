-- ============================================================
-- 280_food_level_nutrition.sql
-- Foods as data: a reference table, and one row per food in a meal.
-- ============================================================
--
-- Until now a meal was a name, four totals and a free-text description. The
-- generator wrote "2 roti, 1 katori dal", the save path joined it into one
-- string, and every later question — how much protein was actually in that
-- meal, was the paneer inside the plan or beside it, did the client eat the
-- dal — became unanswerable.
--
-- This migration adds the two tables that make a food countable:
--
--   foods           the studio's reference foods, plus a curated global seed
--   diet_meal_foods the foods inside a saved meal, with quantity and unit
--
-- It also carries the planning fields a plan now needs to be reproducible:
-- the engine version, the calculation it was generated against, the food
-- culture and the dietary pattern. A plan without those is a document; with
-- them it is a result.
--
-- ── Why foods is a new table, not an extension of meals ────────────────────
--
-- `meals` rows are a composed dish inside a plan. A food is an ingredient
-- with a stable identity and per-unit nutrition. Sharing a table would make
-- "Roti" both a meal and an ingredient, and the two have different owners:
-- the studio owns its foods, the plan owns its meals.
--
-- ── Tenancy ────────────────────────────────────────────────────────────────
--
-- foods uses SPLIT policies, unlike the shared shape elsewhere:
--
--   foods_read   global (organization_id IS NULL) OR the caller's studio
--   foods_write  the caller's studio ONLY
--
-- A studio session must never be able to write a global row. Seed rows are
-- inserted by the migration owner (no app_tenant session), so they are NULL.
--
-- diet_meal_foods has no organization_id of its own: it walks to meals, the
-- same parent-walk shape the platform uses for derived tables.
--
-- ── serving_unit / serving_grams ───────────────────────────────────────────
--
-- serving_unit is the canonical unit word: g, ml, katori, piece, slice,
-- scoop, tbsp, tsp, medium, plate. serving_grams is grams per ONE unit; for
-- g/ml it is the reference quantity the macros are quoted for. The display
-- label ("100 g", "1 katori") is derived at read time, never stored, so a
-- conversion never has to parse a string.

CREATE TABLE IF NOT EXISTS foods (
  id               TEXT PRIMARY KEY,
  organization_id  UUID REFERENCES organizations(id),
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,
  aliases          TEXT[] NOT NULL DEFAULT '{}',
  category         TEXT,
  culture          TEXT NOT NULL DEFAULT 'mixed'
                     CHECK (culture IN ('indian','western','mixed','other')),
  region           TEXT,
  serving_unit     TEXT NOT NULL,
  serving_grams    NUMERIC(8,2) NOT NULL CHECK (serving_grams > 0),
  calories         NUMERIC(7,1) NOT NULL CHECK (calories >= 0),
  protein_g        NUMERIC(6,1),
  carbs_g          NUMERIC(6,1),
  fats_g           NUMERIC(6,1),
  fiber_g          NUMERIC(6,1),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       TEXT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS foods_lookup_idx ON foods (normalized_name);
CREATE INDEX IF NOT EXISTS foods_org_idx ON foods (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS foods_global_name_uidx
  ON foods (normalized_name) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS foods_org_name_uidx
  ON foods (organization_id, normalized_name) WHERE organization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS diet_meal_foods (
  id               TEXT PRIMARY KEY,
  meal_id          TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  food_id          TEXT REFERENCES foods(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  quantity         NUMERIC(8,2) NOT NULL CHECK (quantity > 0),
  unit             TEXT NOT NULL,
  grams            NUMERIC(8,2) CHECK (grams IS NULL OR grams > 0),
  calories         NUMERIC(7,1) NOT NULL CHECK (calories >= 0),
  protein_g        NUMERIC(6,1),
  carbs_g          NUMERIC(6,1),
  fats_g           NUMERIC(6,1),
  fiber_g          NUMERIC(6,1),
  nutrition_source TEXT NOT NULL DEFAULT 'model'
                     CHECK (nutrition_source IN ('reference','model')),
  sort_order       INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS diet_meal_foods_meal_idx
  ON diet_meal_foods (meal_id, sort_order);

ALTER TABLE diet_plan_meals
  ADD COLUMN IF NOT EXISTS slot TEXT CHECK (slot IS NULL OR char_length(slot) <= 40),
  ADD COLUMN IF NOT EXISTS serve_time TEXT
    CHECK (serve_time IS NULL OR serve_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN IF NOT EXISTS day_offset SMALLINT NOT NULL DEFAULT 0
    CHECK (day_offset IN (0, 1));

ALTER TABLE diet_templates
  ADD COLUMN IF NOT EXISTS calculation_version TEXT,
  ADD COLUMN IF NOT EXISTS calculation JSONB,
  ADD COLUMN IF NOT EXISTS food_culture TEXT,
  ADD COLUMN IF NOT EXISTS dietary_pattern TEXT;

-- ── RLS: foods (split read/write) ──────────────────────────────────────────
ALTER TABLE foods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON foods FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON foods;
CREATE POLICY deny_all_direct_access ON foods FOR ALL USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS foods_read ON foods;
CREATE POLICY foods_read ON foods FOR SELECT TO app_tenant
  USING (organization_id IS NULL
         OR organization_id::text = current_setting('app.org_id', true));

-- Deliberately NOT `OR organization_id IS NULL`: a studio session can read a
-- global seed row but must never insert, update or delete one.
DROP POLICY IF EXISTS foods_write ON foods;
CREATE POLICY foods_write ON foods FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON foods TO app_tenant;

-- ── RLS: diet_meal_foods (parent walk to meals) ────────────────────────────
ALTER TABLE diet_meal_foods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON diet_meal_foods FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON diet_meal_foods;
CREATE POLICY deny_all_direct_access ON diet_meal_foods FOR ALL USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS tenant_isolation ON diet_meal_foods;
CREATE POLICY tenant_isolation ON diet_meal_foods FOR ALL TO app_tenant
  USING (EXISTS (SELECT 1 FROM meals m
                  WHERE m.id = diet_meal_foods.meal_id
                    AND m.organization_id::text = current_setting('app.org_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM meals m
                  WHERE m.id = diet_meal_foods.meal_id
                    AND m.organization_id::text = current_setting('app.org_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON diet_meal_foods TO app_tenant;

-- The policies are the isolation. A migration that applies cleanly while one
-- of them is missing would leave the tables readable across studios, so the
-- state this file just created is verified before it can commit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'foods'
       AND policyname = 'foods_read' AND 'app_tenant' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'foods_read policy for app_tenant is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'foods'
       AND policyname = 'foods_write' AND 'app_tenant' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'foods_write policy for app_tenant is missing';
  END IF;

  IF NOT has_table_privilege('app_tenant', 'foods', 'INSERT') THEN
    RAISE EXCEPTION 'app_tenant lacks INSERT on foods';
  END IF;

  IF NOT has_table_privilege('app_tenant', 'diet_meal_foods', 'INSERT') THEN
    RAISE EXCEPTION 'app_tenant lacks INSERT on diet_meal_foods';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'foods'
       AND policyname = 'foods_write'
       AND coalesce(with_check, '') LIKE '%IS NULL%'
  ) THEN
    RAISE EXCEPTION 'foods_write must not allow writing global rows';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'diet_meal_foods'
       AND policyname = 'tenant_isolation'
       AND coalesce(qual, '') LIKE '%organization_id%'
  ) THEN
    RAISE EXCEPTION 'diet_meal_foods tenant_isolation must walk to meals';
  END IF;
END $$;

-- ── The curated global seed ────────────────────────────────────────────────
--
-- Deterministic ids derived from the normalized name, so re-running is a
-- no-op and the rows can be referenced by a known id without a lookup.
INSERT INTO foods (id, organization_id, name, normalized_name, aliases, category, culture, region,
                   serving_unit, serving_grams, calories, protein_g, carbs_g, fats_g, fiber_g)
SELECT 'food-' || substr(md5(v.norm), 1, 24), NULL, v.name, v.norm, v.aliases, v.category,
       v.culture, v.region, v.unit, v.grams, v.kcal, v.p, v.c, v.f, v.fibre
FROM (VALUES
  ('Roti','roti',ARRAY['chapati','phulka'],'grain','indian','North Indian','piece',40,120,3.5,24,1.2,3),
  ('Paratha','paratha',ARRAY[]::text[],'grain','indian','North Indian','piece',60,200,4,26,9,2.5),
  ('Steamed rice','steamed rice',ARRAY['white rice'],'grain','indian','Pan-Indian','katori',150,200,4,44,0.5,0.6),
  ('Brown rice (cooked)','brown rice',ARRAY[]::text[],'grain','indian','Pan-Indian','katori',150,190,4.5,40,1.5,1.8),
  ('Moong dal (cooked)','moong dal',ARRAY['yellow dal'],'dal','indian','Pan-Indian','katori',150,140,9,20,1,4),
  ('Chana dal (cooked)','chana dal',ARRAY[]::text[],'dal','indian','Pan-Indian','katori',150,160,9,24,2,6),
  ('Rajma (cooked)','rajma',ARRAY['kidney bean curry'],'dal','indian','North Indian','katori',150,170,10,27,1,7),
  ('Chole (cooked)','chole',ARRAY['chickpea curry'],'dal','indian','North Indian','katori',150,180,9,28,3,7),
  ('Paneer (raw)','paneer',ARRAY[]::text[],'dairy','indian','Pan-Indian','g',100,265,18,4,20,0),
  ('Paneer bhurji','paneer bhurji',ARRAY[]::text[],'prepared','indian','North Indian','katori',150,290,16,6,22,1),
  ('Curd (plain)','curd',ARRAY['dahi','plain yogurt'],'dairy','indian','Pan-Indian','katori',150,90,5,7,4,0),
  ('Greek yogurt','greek yogurt',ARRAY[]::text[],'dairy','mixed','','g',100,97,9,4,5,0),
  ('Toned milk','toned milk',ARRAY['milk'],'dairy','indian','Pan-Indian','ml',200,116,6,9,6,0),
  ('Boiled egg','boiled egg',ARRAY['egg'],'protein','mixed','','piece',50,78,6,0.6,5,0),
  ('Grilled chicken breast','grilled chicken breast',ARRAY['chicken breast'],'protein','mixed','','g',100,165,31,0,3.6,0),
  ('Chicken curry','chicken curry',ARRAY[]::text[],'prepared','indian','Pan-Indian','katori',150,240,18,6,16,1),
  ('Fish curry','fish curry',ARRAY[]::text[],'prepared','indian','Coastal','katori',150,200,18,5,12,1),
  ('Mutton curry','mutton curry',ARRAY['lamb curry'],'prepared','indian','North Indian','katori',150,290,20,5,21,1),
  ('Idli','idli',ARRAY[]::text[],'prepared','indian','South Indian','piece',40,39,2,8,0.2,0.5),
  ('Plain dosa','plain dosa',ARRAY['dosa'],'prepared','indian','South Indian','piece',80,133,3,20,4,1),
  ('Upma','upma',ARRAY[]::text[],'prepared','indian','South Indian','katori',150,210,5,32,7,3),
  ('Poha','poha',ARRAY[]::text[],'prepared','indian','West Indian','katori',150,250,4,40,8,2),
  ('Sambar','sambar',ARRAY[]::text[],'dal','indian','South Indian','katori',150,110,5,14,3,4),
  ('Rasam','rasam',ARRAY[]::text[],'prepared','indian','South Indian','katori',150,60,2,8,2,2),
  ('Aloo sabzi','aloo sabzi',ARRAY['potato curry'],'vegetable','indian','North Indian','katori',150,180,3,28,6,3),
  ('Bhindi sabzi','bhindi sabzi',ARRAY['okra curry'],'vegetable','indian','North Indian','katori',150,120,2,12,7,4),
  ('Palak paneer','palak paneer',ARRAY[]::text[],'prepared','indian','North Indian','katori',150,250,12,8,19,3),
  ('Dal makhani','dal makhani',ARRAY[]::text[],'dal','indian','North Indian','katori',150,260,9,22,14,7),
  ('Chicken biryani','chicken biryani',ARRAY['biryani'],'prepared','indian','Hyderabadi','plate',250,450,22,50,18,2),
  ('Khichdi','khichdi',ARRAY[]::text[],'prepared','indian','Pan-Indian','katori',200,240,8,38,6,4),
  ('Curd rice','curd rice',ARRAY[]::text[],'prepared','indian','South Indian','katori',200,250,6,40,7,1),
  ('Coconut chutney','coconut chutney',ARRAY[]::text[],'prepared','indian','South Indian','tbsp',30,90,1.5,3,8,2),
  ('Mint chutney','mint chutney',ARRAY[]::text[],'prepared','indian','North Indian','tbsp',30,25,0.8,4,0.7,1.5),
  ('Ghee','ghee',ARRAY[]::text[],'fat','indian','Pan-Indian','tsp',5,45,0,0,5,0),
  ('Mustard oil','mustard oil',ARRAY[]::text[],'fat','indian','East Indian','tsp',5,45,0,0,5,0),
  ('Whole wheat atta','whole wheat atta',ARRAY['atta','whole wheat flour'],'grain','indian','Pan-Indian','g',100,340,12,72,2,10),
  ('Besan','besan',ARRAY['gram flour'],'grain','indian','Pan-Indian','g',100,387,22,58,7,10),
  ('Moong sprouts','moong sprouts',ARRAY['sprouts'],'vegetable','indian','Pan-Indian','katori',100,105,7,18,0.5,5),
  ('Boiled sweet potato','boiled sweet potato',ARRAY['sweet potato'],'vegetable','mixed','','g',100,86,1.6,20,0.1,3),
  ('Boiled potato','boiled potato',ARRAY['potato'],'vegetable','mixed','','g',100,87,2,20,0.1,2),
  ('Banana','banana',ARRAY[]::text[],'fruit','mixed','','medium',120,105,1.3,27,0.4,3),
  ('Apple','apple',ARRAY[]::text[],'fruit','mixed','','medium',180,95,0.5,25,0.3,4),
  ('Papaya','papaya',ARRAY[]::text[],'fruit','mixed','','katori',150,60,0.7,15,0.4,2.5),
  ('Mango','mango',ARRAY[]::text[],'fruit','mixed','','katori',150,90,1.2,22,0.5,2.5),
  ('Guava','guava',ARRAY[]::text[],'fruit','mixed','','medium',150,100,2.5,21,1.4,8),
  ('Almonds','almonds',ARRAY[]::text[],'nut','mixed','','piece',1.2,7,0.25,0.25,0.6,0.15),
  ('Walnuts','walnuts',ARRAY[]::text[],'nut','mixed','','piece',3,20,0.5,0.4,2,0.2),
  ('Roasted peanuts','roasted peanuts',ARRAY['peanuts'],'nut','mixed','','g',30,170,7,5,14,2.5),
  ('Chia seeds','chia seeds',ARRAY[]::text[],'nut','mixed','','tbsp',12,58,2,5,3.7,4),
  ('Flax seeds','flax seeds',ARRAY[]::text[],'nut','mixed','','tbsp',10,55,1.9,3,4.3,2.8),
  ('Oats (dry)','oats',ARRAY['rolled oats'],'grain','mixed','','g',40,150,5,27,3,4),
  ('Ragi flour','ragi flour',ARRAY['finger millet flour'],'grain','indian','South Indian','g',100,336,7,72,1.3,11),
  ('Jowar roti','jowar roti',ARRAY['sorghum roti'],'grain','indian','Deccan','piece',50,110,3,22,1,3),
  ('Bajra roti','bajra roti',ARRAY['millet roti'],'grain','indian','Rajasthani','piece',50,120,3.5,22,1.5,3),
  ('Tea with milk (no sugar)','tea with milk',ARRAY['chai'],'beverage','indian','Pan-Indian','ml',150,40,1.5,3,2,0),
  ('Buttermilk','buttermilk',ARRAY['chaas'],'beverage','indian','Pan-Indian','ml',200,40,2,5,1,0),
  ('Sweet lassi','sweet lassi',ARRAY['lassi'],'beverage','indian','Punjabi','ml',200,180,5,26,6,0),
  ('Chicken tikka','chicken tikka',ARRAY[]::text[],'protein','indian','North Indian','g',100,190,26,4,8,0),
  ('Paneer tikka','paneer tikka',ARRAY[]::text[],'protein','indian','North Indian','g',100,270,18,6,20,0),
  ('Whole wheat bread','whole wheat bread',ARRAY['brown bread'],'grain','western','','slice',30,75,3,13,1,2),
  ('Cooked oatmeal','cooked oatmeal',ARRAY['oatmeal','porridge'],'grain','western','','katori',240,150,5,27,3,4),
  ('Cottage cheese','cottage cheese',ARRAY[]::text[],'dairy','western','','g',100,98,11,3.4,4.3,0),
  ('Cheddar cheese','cheddar cheese',ARRAY['cheese'],'dairy','western','','slice',20,80,5,0.3,6.5,0),
  ('Butter','butter',ARRAY[]::text[],'fat','western','','tsp',5,36,0,0,4,0),
  ('Olive oil','olive oil',ARRAY[]::text[],'fat','western','','tsp',5,44,0,0,5,0),
  ('Grilled salmon','grilled salmon',ARRAY['salmon'],'protein','western','','g',100,208,20,0,13,0),
  ('Tuna in water','tuna',ARRAY['canned tuna'],'protein','western','','g',100,116,26,0,1,0),
  ('Turkey breast','turkey breast',ARRAY[]::text[],'protein','western','','g',100,135,30,0,1,0),
  ('Lean beef','lean beef',ARRAY['beef'],'protein','western','','g',100,217,26,0,12,0),
  ('Tofu','tofu',ARRAY[]::text[],'protein','western','','g',100,76,8,1.9,4.8,0.3),
  ('Tempeh','tempeh',ARRAY[]::text[],'protein','western','','g',100,192,20,7.6,11,0),
  ('Cooked lentils','cooked lentils',ARRAY['lentils'],'dal','western','','katori',150,165,9,20,0.5,8),
  ('Cooked quinoa','quinoa',ARRAY[]::text[],'grain','western','','katori',150,180,6.6,30,2.9,4),
  ('Cooked pasta','pasta',ARRAY[]::text[],'grain','western','','katori',150,220,8,43,1.3,2.5),
  ('Sweet corn','sweet corn',ARRAY['corn'],'vegetable','western','','katori',150,130,5,28,1.5,3),
  ('Steamed broccoli','broccoli',ARRAY[]::text[],'vegetable','western','','katori',150,50,4,10,0.6,5),
  ('Cooked spinach','spinach',ARRAY[]::text[],'vegetable','western','','katori',150,40,4,5,0.5,3),
  ('Blueberries','blueberries',ARRAY[]::text[],'fruit','western','','katori',100,57,0.7,14,0.3,2.4),
  ('Peanut butter','peanut butter',ARRAY[]::text[],'nut','western','','tbsp',16,95,3.5,3,8,1),
  ('Whey protein','whey protein',ARRAY['whey'],'protein','western','','scoop',30,120,24,3,1.5,0)
) AS v(name, norm, aliases, category, culture, region, unit, grams, kcal, p, c, f, fibre)
ON CONFLICT DO NOTHING;
