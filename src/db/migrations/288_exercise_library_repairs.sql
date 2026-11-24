-- 288_exercise_library_repairs.sql
-- Repair the exercise-library rows the 2026-11-24 read-only audit found.
--
-- ── What this migration is, and is not ────────────────────────────────────
--
-- The structured layer was already clean: `primary_muscle_id` agreed with
-- `target_muscle`/`muscle_group`, `equipment_id` agreed with `equipment`, and
-- `exercise_muscles` had no orphan or multi-primary rows. The defects were
-- concentrated in identity, target/pattern and equipment labels:
--
--   · `Pullups` / `Pushups` are the same movements as `Pull Ups` / `Push Ups`,
--     under a no-space spelling. Both pairs were live at once, so the screen
--     could allow one spelling and caution the other, and plan history split
--     across two ids.
--   · Six rows named a muscle that is not the one doing the work, or a
--     movement pattern that is not the movement. The worst is
--     `Bench Press - Powerlifting`, whose primary was Triceps while the row
--     was prescribed as a bench press.
--   · Six rows carried the wrong equipment label. Three band movements were
--     `Other`, which the screen treats as unavailable to every client with a
--     non-null equipment list, and two EZ-bar movements plus one Smith row
--     were `Barbell`.
--
-- No row is hard-deleted. `Ab Roller (Copy)` is deliberately NOT touched: it
-- is a custom row owned by one studio, not part of the shared library, and its
-- owner has not confirmed it is disposable. It stays until that confirmation
-- arrives; deleting another studio's work from a library-wide migration is not
-- this migration's call.
--
-- Idempotent: every statement is guarded by the old value or by ON CONFLICT,
-- so a second run changes nothing. migrate.js owns the transaction.

-- ── 1. Duplicate identities ────────────────────────────────────────────────
--
-- Keep the spaced rows (`pull-ups`, `push-ups`): plans already reference them,
-- and they are the spelling the rest of the library uses. The no-space rows
-- carry metadata the spaced rows lack — force, mechanic and the secondary
-- muscles — so fold that in before retiring them.

UPDATE exercises keep
SET force = COALESCE(keep.force, dup.force),
    mechanic = COALESCE(keep.mechanic, dup.mechanic),
    search_keywords = CASE
      WHEN keep.search_keywords IS NULL OR keep.search_keywords = '' THEN dup.search_keywords
      WHEN dup.search_keywords IS NULL OR dup.search_keywords = '' THEN keep.search_keywords
      WHEN position(lower(dup.name) IN lower(keep.search_keywords)) > 0 THEN keep.search_keywords
      ELSE btrim(keep.search_keywords || ' ' || dup.search_keywords)
    END
FROM exercises dup
WHERE keep.slug = 'pull-ups'
  AND dup.slug = 'pullups'
  AND keep.deleted_at IS NULL;

UPDATE exercises keep
SET force = COALESCE(keep.force, dup.force),
    mechanic = COALESCE(keep.mechanic, dup.mechanic),
    search_keywords = CASE
      WHEN keep.search_keywords IS NULL OR keep.search_keywords = '' THEN dup.search_keywords
      WHEN dup.search_keywords IS NULL OR dup.search_keywords = '' THEN keep.search_keywords
      WHEN position(lower(dup.name) IN lower(keep.search_keywords)) > 0 THEN keep.search_keywords
      ELSE btrim(keep.search_keywords || ' ' || dup.search_keywords)
    END
FROM exercises dup
WHERE keep.slug = 'push-ups'
  AND dup.slug = 'pushups'
  AND keep.deleted_at IS NULL;

-- Carry the secondary movers across. A duplicate that is retired should not
-- take the only record of "pull-ups train biceps" with it.
INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT keep.id, em.muscle_id, em.role
FROM exercises keep
JOIN exercises dup ON dup.slug = 'pullups'
JOIN exercise_muscles em ON em.exercise_id = dup.id
WHERE keep.slug = 'pull-ups' AND keep.deleted_at IS NULL
ON CONFLICT (exercise_id, muscle_id) DO NOTHING;

INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT keep.id, em.muscle_id, em.role
FROM exercises keep
JOIN exercises dup ON dup.slug = 'pushups'
JOIN exercise_muscles em ON em.exercise_id = dup.id
WHERE keep.slug = 'push-ups' AND keep.deleted_at IS NULL
ON CONFLICT (exercise_id, muscle_id) DO NOTHING;

-- Repoint every reference before the old row is retired. `Pushups` has one
-- plan row and one logged session; `Pullups` has none. The logged row keeps
-- the name it was logged under until this update, then follows the canonical
-- spelling so a later read does not show two spellings of one movement.
UPDATE workout_exercises we
SET exercise_id = pair.keep_id
FROM (
  SELECT dup.id AS dup_id, keep.id AS keep_id
  FROM exercises dup
  JOIN exercises keep
    ON keep.slug = 'push-ups' AND keep.deleted_at IS NULL
  WHERE dup.slug = 'pushups'
) pair
WHERE we.exercise_id = pair.dup_id;

UPDATE workout_session_exercises wse
SET exercise_id = pair.keep_id,
    exercise_name = pair.keep_name
FROM (
  SELECT dup.id AS dup_id, keep.id AS keep_id, keep.name AS keep_name
  FROM exercises dup
  JOIN exercises keep
    ON keep.slug = 'push-ups' AND keep.deleted_at IS NULL
  WHERE dup.slug = 'pushups'
) pair
WHERE wse.exercise_id = pair.dup_id;

-- "Recently used" is keyed by (user_id, exercise_id). One trainer used both
-- spellings, so a plain repoint would collide; merge the counts instead of
-- dropping either.
INSERT INTO exercise_recent_usage (user_id, exercise_id, use_count, used_at)
SELECT r.user_id, keep.id, r.use_count, r.used_at
FROM exercise_recent_usage r
JOIN exercises dup ON dup.id = r.exercise_id AND dup.slug = 'pushups'
JOIN exercises keep ON keep.slug = 'push-ups' AND keep.deleted_at IS NULL
ON CONFLICT (user_id, exercise_id) DO UPDATE
SET use_count = exercise_recent_usage.use_count + EXCLUDED.use_count,
    used_at = GREATEST(exercise_recent_usage.used_at, EXCLUDED.used_at);

DELETE FROM exercise_recent_usage
WHERE exercise_id IN (
  SELECT id FROM exercises
  WHERE slug = 'pushups'
);

-- Soft-delete, never hard-delete: an old plan or export may still point at
-- these ids, and the resolver must be able to say what they were.
UPDATE exercises
SET deleted_at = NOW(), is_active = FALSE
WHERE slug IN ('pullups', 'pushups')
  AND deleted_at IS NULL;

-- The old spelling still arrives in historical AI output and in trainers'
-- notes. An alias resolves it to the surviving row without making the
-- resolver guess: "Pullups" is a written synonym, not a fuzzy match.
INSERT INTO exercise_aliases (exercise_id, organization_id, alias)
SELECT e.id, NULL, v.alias
FROM (VALUES
  ('pull-ups', 'Pullups'),
  ('push-ups', 'Pushups')
) AS v(slug, alias)
JOIN exercises e
  ON e.slug = v.slug
 AND e.organization_id IS NULL
 AND e.deleted_at IS NULL
 AND e.archived_at IS NULL
ON CONFLICT DO NOTHING;

-- ── 2. Target muscle and movement pattern ──────────────────────────────────
--
-- `exercises_sync_legacy_columns` derives target_muscle / muscle_group /
-- body_part from primary_muscle_id, so writing the FK is the authoritative
-- part; the flat columns are restated for the reader and for a database where
-- the trigger is ever absent.

UPDATE exercises e
SET target_muscle = f.new_target,
    muscle_group = f.new_group,
    movement_pattern = f.new_pattern,
    primary_muscle_id = f.new_muscle_id
FROM (
  SELECT f.slug, f.old_target, f.new_target, f.new_group, f.new_pattern,
         m.id AS new_muscle_id
  FROM (VALUES
    -- Quadruped hip extension, not a quad stretch. A knee/quad constraint
    -- should not block it; a glute constraint should find it.
    ('rear-leg-raises',           'Quadriceps', 'Glutes',     'Legs',     'Hinge',     'Glutes'),
    -- Standing hip abduction, not adduction.
    ('side-leg-raises',           'Adductors',  'Abductors',  'Legs',     'Isolation', 'Abductors'),
    -- Leg swings are mobility; the target (hamstrings) was already plausible.
    ('front-leg-raises',          'Hamstrings', 'Hamstrings', 'Legs',     'Mobility',  'Hamstrings'),
    -- A chest pass is a chest-driven horizontal push, not a triceps pull.
    ('supine-chest-throw',        'Triceps',    'Chest',      'Chest',    'Horizontal Push', 'Chest'),
    -- Three bench-press variants were filed under the triceps. The bar is
    -- moved by the chest; the triceps are a secondary mover.
    ('bench-press-powerlifting',  'Triceps',    'Chest',      'Chest',    'Horizontal Push', 'Chest'),
    ('bench-press-with-chains',   'Triceps',    'Chest',      'Chest',    'Horizontal Push', 'Chest'),
    ('reverse-band-bench-press',  'Triceps',    'Chest',      'Chest',    'Horizontal Push', 'Chest')
  ) AS f(slug, old_target, new_target, new_group, new_pattern, new_muscle)
  JOIN muscles m ON m.name = f.new_muscle
) f
WHERE e.slug = f.slug
  AND e.deleted_at IS NULL
  AND e.target_muscle = f.old_target;

-- Move the primary flag in exercise_muscles with the column. A bench press
-- that says Chest in `target_muscle` but Triceps in its primary muscle map is
-- the same contradiction one layer down. The old primary is deleted, not
-- demoted, so the rows that had Triceps as their only muscle entry get it back
-- as a secondary mover below — the movement is still a triceps exercise, it is
-- just not the muscle the row is filed under.
DELETE FROM exercise_muscles em
WHERE em.role = 'primary'
  AND EXISTS (
    SELECT 1
    FROM (VALUES
      ('rear-leg-raises',          'Quadriceps'),
      ('side-leg-raises',          'Adductors'),
      ('supine-chest-throw',       'Triceps'),
      ('bench-press-powerlifting', 'Triceps'),
      ('bench-press-with-chains',  'Triceps'),
      ('reverse-band-bench-press', 'Triceps')
    ) AS f(slug, old_muscle)
    JOIN exercises e ON e.slug = f.slug
    JOIN muscles m ON m.name = f.old_muscle
    WHERE em.exercise_id = e.id
      AND em.muscle_id = m.id
  );

INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT e.id, m.id, 'primary'
FROM (VALUES
  ('rear-leg-raises',          'Glutes'),
  ('side-leg-raises',          'Abductors'),
  ('supine-chest-throw',       'Chest'),
  ('bench-press-powerlifting', 'Chest'),
  ('bench-press-with-chains',  'Chest'),
  ('reverse-band-bench-press', 'Chest')
) AS f(slug, new_muscle)
JOIN exercises e ON e.slug = f.slug AND e.deleted_at IS NULL
JOIN muscles m ON m.name = f.new_muscle
ON CONFLICT (exercise_id, muscle_id) DO UPDATE SET role = 'primary';

-- The triceps did the work in these four rows before the repair; they still
-- assist, so keep them in the map as secondary rather than dropping the only
-- record of the relationship when the primary flag moves to the chest.
INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT e.id, m.id, 'secondary'
FROM (VALUES
  ('supine-chest-throw'),
  ('bench-press-powerlifting'),
  ('bench-press-with-chains'),
  ('reverse-band-bench-press')
) AS f(slug)
JOIN exercises e ON e.slug = f.slug AND e.deleted_at IS NULL
JOIN muscles m ON m.name = 'Triceps'
ON CONFLICT (exercise_id, muscle_id) DO NOTHING;

-- `secondary_muscles` is the legacy text copy of the map. Rebuild it for the
-- rows this migration touched so the detail screen does not show Chest as
-- both primary and secondary on a bench press. The map above is authoritative.
UPDATE exercises e
SET secondary_muscles = (
  SELECT string_agg(lower(m.name), ', ' ORDER BY m.name)
  FROM exercise_muscles em
  JOIN muscles m ON m.id = em.muscle_id
  WHERE em.exercise_id = e.id AND em.role = 'secondary'
)
WHERE e.slug IN (
  'rear-leg-raises', 'side-leg-raises', 'front-leg-raises', 'supine-chest-throw',
  'bench-press-powerlifting', 'bench-press-with-chains', 'reverse-band-bench-press'
);

-- ── 3. Equipment labels ────────────────────────────────────────────────────
--
-- `equipmentFrom` in programming-rules.js never infers `Other`, so every
-- `Other` row is blocked for a client whose equipment list is non-null. These
-- three are band movements and belong in `Resistance Band`. The EZ-bar and
-- Smith rows are label corrections; the other 19 Smith rows already say
-- `Machine`.

UPDATE exercises e
SET equipment = f.new_equipment,
    equipment_id = f.new_equipment_id
FROM (
  SELECT f.slug, f.old_equipment, f.new_equipment, et.id AS new_equipment_id
  FROM (VALUES
    ('band-assisted-pull-up',          'Other',   'Resistance Band'),
    ('seated-band-hamstring-curl',     'Other',   'Resistance Band'),
    ('weighted-sit-ups-with-bands',    'Other',   'Resistance Band'),
    ('close-grip-ez-bar-curl',         'Barbell', 'EZ Curl Bar'),
    ('decline-ez-bar-triceps-extension','Barbell','EZ Curl Bar'),
    ('smith-incline-shoulder-raise',   'Barbell', 'Machine')
  ) AS f(slug, old_equipment, new_equipment)
  JOIN equipment_types et ON et.name = f.new_equipment
) f
WHERE e.slug = f.slug
  AND e.deleted_at IS NULL
  AND e.equipment = f.old_equipment;
