-- 289_exercise_library_followups.sql
-- Finish the exercise-library repairs 288 started and close the gaps the
-- post-deploy audit found.
--
-- ── What this migration changes ───────────────────────────────────────────
--
-- 1. `secondary_muscles` is the legacy text copy of `exercise_muscles`. 288
--    rebuilt it for the seven target/pattern rows only; 25 active built-in
--    rows still disagree with the map: two have null text, nine repeat the
--    primary as a secondary, and the rest are missing a mover or carrying a
--    stale one. The map is authoritative, so every disagreeing built-in row is
--    rebuilt from it. A row whose map has no secondary movers gets NULL rather
--    than a copy of its primary. The one custom row with the same gap
--    (`Ab Roller (Copy)`) is left alone: it belongs to a studio, not the
--    shared library.
--
-- 2. 288 repointed plan, session and recent-use references for `pushups`
--    only. Production had no `pullups` references, so nothing is orphaned
--    today, but a staging or restored database can. Both spellings are
--    handled here, and favourites are carried across too.
--
-- 3. 120 active rows used equipment `Other`, which `equipmentFrom` treats as
--    unavailable to a client with a non-null equipment list. Some are genuine
--    odd equipment (stones, sleds, yokes, ropes, plates, chains); those stay
--    `Other`. The ones whose vocabulary is unambiguous move to it:
--    bodyweight stretches, calisthenics and plyometrics, suspension rows,
--    foam-roller SMR, the trap-bar deadlift, the two machine movements, and
--    the exercise-ball crunch.
--
-- Idempotent: every statement is guarded by the old value or by ON CONFLICT,
-- so a second run changes nothing. No row is hard-deleted. `Ab Roller (Copy)`
-- is deliberately untouched: it is a studio's custom row and its owner has
-- not confirmed it is disposable. migrate.js owns the transaction.

-- ── 1. Rebuild the legacy secondary text from the map ──────────────────────
--
-- Compare SETS, not arrays: the seeded text is lowercase and ordered by name,
-- while the map is ordered by muscle sort_order. A case/order difference is
-- not a defect and is left alone, so this touches the 26 rows that actually
-- disagree rather than rewriting 599 cosmetic ones.

WITH mismatched AS (
  SELECT e.id
  FROM exercises e
  WHERE e.deleted_at IS NULL
    AND e.organization_id IS NULL
    AND EXISTS (SELECT 1 FROM exercise_muscles em WHERE em.exercise_id = e.id)
    AND (
      SELECT array_agg(DISTINCT lower(trim(x)) ORDER BY lower(trim(x)))
      FROM unnest(string_to_array(COALESCE(e.secondary_muscles, ''), ',')) AS x
      WHERE trim(x) <> ''
    ) IS DISTINCT FROM (
      SELECT array_agg(DISTINCT lower(m.name) ORDER BY lower(m.name))
      FROM exercise_muscles em
      JOIN muscles m ON m.id = em.muscle_id
      WHERE em.exercise_id = e.id AND em.role = 'secondary'
    )
)
UPDATE exercises e
SET secondary_muscles = (
  SELECT string_agg(lower(m.name), ', ' ORDER BY m.name)
  FROM exercise_muscles em
  JOIN muscles m ON m.id = em.muscle_id
  WHERE em.exercise_id = e.id AND em.role = 'secondary'
)
WHERE e.id IN (SELECT id FROM mismatched);

-- ── 2. Carry both retired spellings' references ────────────────────────────
--
-- The pairs are looked up by slug, so this is a no-op on a database where the
-- duplicate rows were never seeded. `keep` must still be active; a retired
-- row is not a destination.

UPDATE workout_exercises we
SET exercise_id = p.keep_id
FROM (
  SELECT dup.id AS dup_id, keep.id AS keep_id
  FROM (VALUES ('pullups', 'pull-ups'), ('pushups', 'push-ups')) AS v(dup_slug, keep_slug)
  JOIN exercises dup ON dup.slug = v.dup_slug
  JOIN exercises keep ON keep.slug = v.keep_slug AND keep.deleted_at IS NULL
) p
WHERE we.exercise_id = p.dup_id;

UPDATE workout_session_exercises wse
SET exercise_id = p.keep_id,
    exercise_name = p.keep_name
FROM (
  SELECT dup.id AS dup_id, keep.id AS keep_id, keep.name AS keep_name
  FROM (VALUES ('pullups', 'pull-ups'), ('pushups', 'push-ups')) AS v(dup_slug, keep_slug)
  JOIN exercises dup ON dup.slug = v.dup_slug
  JOIN exercises keep ON keep.slug = v.keep_slug AND keep.deleted_at IS NULL
) p
WHERE wse.exercise_id = p.dup_id;

INSERT INTO exercise_recent_usage (user_id, exercise_id, use_count, used_at)
SELECT r.user_id, p.keep_id, r.use_count, r.used_at
FROM exercise_recent_usage r
JOIN (
  SELECT dup.id AS dup_id, keep.id AS keep_id
  FROM (VALUES ('pullups', 'pull-ups'), ('pushups', 'push-ups')) AS v(dup_slug, keep_slug)
  JOIN exercises dup ON dup.slug = v.dup_slug
  JOIN exercises keep ON keep.slug = v.keep_slug AND keep.deleted_at IS NULL
) p ON p.dup_id = r.exercise_id
ON CONFLICT (user_id, exercise_id) DO UPDATE
SET use_count = exercise_recent_usage.use_count + EXCLUDED.use_count,
    used_at = GREATEST(exercise_recent_usage.used_at, EXCLUDED.used_at);

DELETE FROM exercise_recent_usage r
USING (
  SELECT dup.id AS dup_id
  FROM (VALUES ('pullups', 'pull-ups'), ('pushups', 'push-ups')) AS v(dup_slug, keep_slug)
  JOIN exercises dup ON dup.slug = v.dup_slug
  JOIN exercises keep ON keep.slug = v.keep_slug AND keep.deleted_at IS NULL
) p
WHERE r.exercise_id = p.dup_id;

INSERT INTO exercise_favorites (user_id, exercise_id)
SELECT f.user_id, p.keep_id
FROM exercise_favorites f
JOIN (
  SELECT dup.id AS dup_id, keep.id AS keep_id
  FROM (VALUES ('pullups', 'pull-ups'), ('pushups', 'push-ups')) AS v(dup_slug, keep_slug)
  JOIN exercises dup ON dup.slug = v.dup_slug
  JOIN exercises keep ON keep.slug = v.keep_slug AND keep.deleted_at IS NULL
) p ON p.dup_id = f.exercise_id
ON CONFLICT DO NOTHING;

DELETE FROM exercise_favorites f
USING (
  SELECT dup.id AS dup_id
  FROM (VALUES ('pullups', 'pull-ups'), ('pushups', 'push-ups')) AS v(dup_slug, keep_slug)
  JOIN exercises dup ON dup.slug = v.dup_slug
  JOIN exercises keep ON keep.slug = v.keep_slug AND keep.deleted_at IS NULL
) p
WHERE f.exercise_id = p.dup_id;

-- ── 3. Equipment labels with an unambiguous vocabulary value ───────────────
--
-- Guarded by the old label, so a row someone has already corrected (or a
-- custom row with the same slug) is not touched. `equipment` and
-- `equipment_id` move together; the legacy sync trigger derives the text from
-- the id, so writing only one of them would be undone on the next edit.

UPDATE exercises e
SET equipment = f.new_equipment,
    equipment_id = f.new_equipment_id
FROM (
  SELECT f.slug, f.old_equipment, f.new_equipment, et.id AS new_equipment_id
  FROM (VALUES
    -- Stretches: no external load, so Bodyweight is the honest label and the
    -- one a client with any equipment list can still do.
    ('behind-head-chest-stretch',             'Other', 'Bodyweight'),
    ('chair-leg-extended-stretch',            'Other', 'Bodyweight'),
    ('chair-upper-body-stretch',              'Other', 'Bodyweight'),
    ('chest-and-front-of-shoulder-stretch',   'Other', 'Bodyweight'),
    ('intermediate-groin-stretch',            'Other', 'Bodyweight'),
    ('intermediate-hip-flexor-and-quad-stretch','Other','Bodyweight'),
    ('it-band-and-glute-stretch',             'Other', 'Bodyweight'),
    ('lying-bent-leg-groin',                  'Other', 'Bodyweight'),
    ('lying-hamstring',                       'Other', 'Bodyweight'),
    ('on-your-back-quad-stretch',             'Other', 'Bodyweight'),
    ('overhead-lat',                          'Other', 'Bodyweight'),
    ('peroneals-stretch',                     'Other', 'Bodyweight'),
    ('posterior-tibialis-stretch',            'Other', 'Bodyweight'),
    ('quad-stretch',                          'Other', 'Bodyweight'),
    ('round-the-world-shoulder-stretch',      'Other', 'Bodyweight'),
    ('seated-hamstring-and-calf-stretch',     'Other', 'Bodyweight'),
    ('standing-biceps-stretch',               'Other', 'Bodyweight'),
    ('standing-elevated-quad-stretch',        'Other', 'Bodyweight'),
    ('standing-hamstring-and-calf-stretch',   'Other', 'Bodyweight'),
    ('one-handed-hang',                       'Other', 'Bodyweight'),
    -- Calisthenics and pull-up/chin-up variants: the bar is the only prop.
    ('bodyweight-mid-row',                    'Other', 'Bodyweight'),
    ('dips-chest-version',                    'Other', 'Bodyweight'),
    ('parallel-bar-dip',                      'Other', 'Bodyweight'),
    ('ring-dips',                             'Other', 'Bodyweight'),
    ('knee-hip-raise-on-parallel-bars',       'Other', 'Bodyweight'),
    ('gironda-sternum-chins',                 'Other', 'Bodyweight'),
    ('kipping-muscle-up',                     'Other', 'Bodyweight'),
    ('muscle-up',                             'Other', 'Bodyweight'),
    ('one-arm-chin-up',                       'Other', 'Bodyweight'),
    ('mixed-grip-chin',                       'Other', 'Bodyweight'),
    ('rocky-pull-ups-pulldowns',              'Other', 'Bodyweight'),
    ('side-to-side-chins',                    'Other', 'Bodyweight'),
    ('weighted-pull-ups',                     'Other', 'Bodyweight'),
    ('weighted-bench-dip',                    'Other', 'Bodyweight'),
    ('weighted-squat',                        'Other', 'Bodyweight'),
    ('otis-up',                               'Other', 'Bodyweight'),
    ('london-bridges',                        'Other', 'Bodyweight'),
    ('rope-climb',                            'Other', 'Bodyweight'),
    ('single-leg-high-box-squat',             'Other', 'Bodyweight'),
    -- Plyometrics: jumps, hops and sprints need no load.
    ('bench-sprint',                          'Other', 'Bodyweight'),
    ('box-jump-multiple-response',            'Other', 'Bodyweight'),
    ('box-skip',                              'Other', 'Bodyweight'),
    ('depth-jump-leap',                       'Other', 'Bodyweight'),
    ('drop-push',                             'Other', 'Bodyweight'),
    ('front-box-jump',                        'Other', 'Bodyweight'),
    ('front-cone-hops-or-hurdle-hops',        'Other', 'Bodyweight'),
    ('hurdle-hops',                           'Other', 'Bodyweight'),
    ('incline-push-up-depth-jump',            'Other', 'Bodyweight'),
    ('lateral-box-jump',                      'Other', 'Bodyweight'),
    ('lateral-cone-hops',                     'Other', 'Bodyweight'),
    ('linear-depth-jump',                     'Other', 'Bodyweight'),
    ('quick-leap',                            'Other', 'Bodyweight'),
    ('side-hop-sprint',                       'Other', 'Bodyweight'),
    ('side-to-side-box-shuffle',              'Other', 'Bodyweight'),
    ('single-leg-push-off',                   'Other', 'Bodyweight'),
    ('single-cone-sprint-drill',              'Other', 'Bodyweight'),
    ('single-leg-hop-progression',            'Other', 'Bodyweight'),
    ('single-leg-lateral-hop',                'Other', 'Bodyweight'),
    ('single-leg-stride-jump',                'Other', 'Bodyweight'),
    ('stride-jump-crossover',                 'Other', 'Bodyweight'),
    -- Suspension work: the trainer has the vocabulary value already.
    ('suspended-fallout',                     'Other', 'Suspension Trainer'),
    ('suspended-push-up',                     'Other', 'Suspension Trainer'),
    ('suspended-reverse-crunch',              'Other', 'Suspension Trainer'),
    ('suspended-row',                         'Other', 'Suspension Trainer'),
    ('suspended-split-squat',                 'Other', 'Suspension Trainer'),
    ('inverted-row-with-straps',              'Other', 'Suspension Trainer'),
    -- SMR rows whose siblings already say Foam Roller.
    ('anterior-tibialis-smr',                 'Other', 'Foam Roller'),
    ('foot-smr',                              'Other', 'Foam Roller'),
    ('neck-smr',                              'Other', 'Foam Roller'),
    -- A trap bar is its own equipment type, not "Other".
    ('trap-bar-deadlift',                     'Other', 'Trap Bar'),
    -- The bench/machine is what makes the movement possible.
    ('donkey-calf-raises',                    'Other', 'Machine'),
    ('hyperextensions-back-extensions',       'Other', 'Machine')
  ) AS f(slug, old_equipment, new_equipment)
  JOIN equipment_types et ON et.name = f.new_equipment
) f
WHERE e.slug = f.slug
  AND e.organization_id IS NULL
  AND e.deleted_at IS NULL
  AND e.equipment = f.old_equipment;

-- The exercise-ball crunch was filed as Bodyweight. The ball is the load.
UPDATE exercises e
SET equipment = 'Exercise Ball',
    equipment_id = et.id
FROM equipment_types et
WHERE et.name = 'Exercise Ball'
  AND e.slug = 'crunch-legs-on-exercise-ball'
  AND e.organization_id IS NULL
  AND e.deleted_at IS NULL
  AND e.equipment = 'Bodyweight';
