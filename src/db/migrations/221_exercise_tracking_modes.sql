-- ============================================================
-- 221_exercise_tracking_modes.sql
--
-- Gives every built-in exercise a TRACKING MODE, so the plan builder, the
-- trainer's logger and the member app ask for the numbers the exercise is
-- actually measured in — load × reps for a bench press, seconds for a plank,
-- metres under load for a farmer's walk, time/distance for a treadmill run.
--
-- ── What the audit found (29 Sep 2026, production) ──────────────────────
--
--   * Only the 14 Cardio rows (migration 174) had a prescription mode. The
--     other 876 fell back to "sets × reps × kg" — including 123 stretches,
--     the planks, the carries and the sled work.
--   * Migration 141 compared exercise_type against lowercase values
--     ('stretching', 'powerlifting' …) AFTER its own category backfill had
--     fired the legacy-sync trigger and title-cased that column. None of
--     those branches ever matched: every stretch got "3-4 × 10-15 reps" and
--     every competition lift "6-10" instead of "3-5". 141 is fixed in place
--     for fresh installs and the importer; this migration repairs the rows.
--   * Treadmill Running and Jump Rope — two of the original twelve hand-seeded
--     exercises and among the most-programmed in the studio — sat in the
--     Strength category, so the logger offered them kg × reps. Each has a
--     proper Cardio twin from the dataset ("Running, Treadmill",
--     "Rope Jumping"), as do four more seeds (Plank, Cable Crunch, Incline
--     Dumbbell Press, Leg Press — the last two wrongly tagged Bodyweight).
--   * The Cardio body region listed only those two mis-filed seeds; the 14
--     real cardio exercises were filed under Legs by their dataset muscle.
--
-- ── Vocabulary ──────────────────────────────────────────────────────────
--
-- prescription_mode_primary keeps the migration-174 values and gains two,
-- matching the Training OS prescription_type names so both speak one language:
--
--   WEIGHT_REPS    load × reps                          barbell, machine …
--   BODYWEIGHT     reps, added load optional            push-up, pull-up …
--   REPS           reps, load optional (non-bodyweight) resistance band …
--   HOLD           seconds held, added load optional    plank, stretches
--   DISTANCE_LOAD  distance under load                  carries, sleds
--   TIME …         the cardio vocabulary from 174
--
-- NULL still means "legacy, treat as WEIGHT_REPS", so a custom exercise a
-- studio authored before this migration behaves exactly as it did.
--
-- ── Safety ──────────────────────────────────────────────────────────────
--
--   * Built-in rows only (organization_id IS NULL). A studio's own exercises
--     are its trainers' decisions, not this migration's.
--   * Modes are only written where still NULL — the 14 curated cardio rows
--     are untouched.
--   * Recommended sets/reps are only rewritten where they still hold a value
--     141 generated, so a hand edit survives.
--   * Duplicates are merged by repointing references and SOFT-deleting the
--     loser. No row is hard-deleted, no id changes, logged history keeps its
--     exercise_name. The archive schema is deliberately not touched.
--   * Idempotent: every statement is guarded, a re-run changes nothing.
-- ============================================================

-- A backfill is not an edit a trainer made; keep it out of version history
-- (same reasoning as 141).
ALTER TABLE exercises DISABLE TRIGGER exercises_version_history;


-- ─── 1. VOCABULARY ───────────────────────────────────────────
ALTER TABLE exercises DROP CONSTRAINT IF EXISTS exercises_prescription_mode_primary_check;
ALTER TABLE exercises ADD CONSTRAINT exercises_prescription_mode_primary_check
  CHECK (prescription_mode_primary IS NULL OR prescription_mode_primary IN (
    'WEIGHT_REPS','BODYWEIGHT','REPS','HOLD',
    'TIME','DISTANCE','SPEED','PACE','TIME_SPEED','TIME_DISTANCE',
    'DISTANCE_LOAD','TIME_LOAD','CALORIES','HEART_RATE','RPE','INTERVAL',
    'ROUNDS','RPM','STEPS','FLOORS'
  ));

COMMENT ON COLUMN exercises.prescription_mode_primary IS
  'How this exercise is tracked by default (WEIGHT_REPS, BODYWEIGHT, REPS, HOLD, DISTANCE_LOAD, TIME …). NULL means legacy WEIGHT_REPS.';


-- ─── 2. MERGE DUPLICATE SEEDS ────────────────────────────────
-- loser = the hand-seeded row (no source_id), keeper = the dataset row.
-- Matched by name/source_id rather than id so a fresh install, whose seeds
-- got different uuids, is repaired the same way.
DO $$
DECLARE
  pair RECORD;
  loser_id  TEXT;
  keeper_id TEXT;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('Treadmill Running',      'Running_Treadmill'),
      ('Jump Rope',              'Rope_Jumping'),
      ('Plank',                  'Plank'),
      ('Cable Crunch',           'Cable_Crunch'),
      ('Incline Dumbbell Press', 'Incline_Dumbbell_Press'),
      ('Leg Press',              'Leg_Press')
    ) AS v(seed_name, keeper_source_id)
  LOOP
    SELECT id INTO keeper_id FROM exercises
     WHERE source_id = pair.keeper_source_id AND deleted_at IS NULL
     ORDER BY created_at LIMIT 1;
    SELECT id INTO loser_id FROM exercises
     WHERE name = pair.seed_name AND source_id IS NULL
       AND organization_id IS NULL AND is_custom IS NOT TRUE
       AND deleted_at IS NULL
     ORDER BY created_at LIMIT 1;

    CONTINUE WHEN keeper_id IS NULL OR loser_id IS NULL OR keeper_id = loser_id;

    UPDATE workout_exercises         SET exercise_id = keeper_id WHERE exercise_id = loser_id;
    UPDATE workout_session_exercises SET exercise_id = keeper_id WHERE exercise_id = loser_id;

    INSERT INTO exercise_favorites (user_id, exercise_id, created_at)
    SELECT user_id, keeper_id, created_at FROM exercise_favorites WHERE exercise_id = loser_id
    ON CONFLICT (user_id, exercise_id) DO NOTHING;
    DELETE FROM exercise_favorites WHERE exercise_id = loser_id;

    INSERT INTO exercise_recent_usage (user_id, exercise_id, use_count, used_at)
    SELECT user_id, keeper_id, use_count, used_at FROM exercise_recent_usage WHERE exercise_id = loser_id
    ON CONFLICT (user_id, exercise_id) DO UPDATE
      SET use_count = exercise_recent_usage.use_count + EXCLUDED.use_count,
          used_at   = GREATEST(exercise_recent_usage.used_at, EXCLUDED.used_at);
    DELETE FROM exercise_recent_usage WHERE exercise_id = loser_id;

    INSERT INTO exercise_relations (exercise_id, related_exercise_id, relation_type, sort_order)
    SELECT keeper_id, related_exercise_id, relation_type, sort_order
      FROM exercise_relations WHERE exercise_id = loser_id AND related_exercise_id <> keeper_id
    ON CONFLICT DO NOTHING;
    INSERT INTO exercise_relations (exercise_id, related_exercise_id, relation_type, sort_order)
    SELECT exercise_id, keeper_id, relation_type, sort_order
      FROM exercise_relations WHERE related_exercise_id = loser_id AND exercise_id <> keeper_id
    ON CONFLICT DO NOTHING;
    DELETE FROM exercise_relations WHERE exercise_id = loser_id OR related_exercise_id = loser_id;

    UPDATE exercises SET deleted_at = NOW(), is_active = FALSE WHERE id = loser_id;

    RAISE NOTICE '221: merged "%" (%) into % ', pair.seed_name, loser_id, keeper_id;
  END LOOP;
END $$;


-- ─── 2b. THE ORIGINAL SEEDS' EQUIPMENT ───────────────────────
-- Every hand-seeded row was stored as "Bodyweight", so Bench Press and Squat
-- would classify below as bodyweight movements with no load. Only rows still
-- carrying that seed value are corrected; the legacy-sync trigger updates the
-- text column from the FK.
UPDATE exercises e
   SET equipment_id = q.id
  FROM equipment_types q, (VALUES
    ('Barbell Row',     'barbell'),
    ('Bench Press',     'barbell'),
    ('Bicep Curl',      'dumbbell'),
    ('Deadlift',        'barbell'),
    ('Lat Pulldown',    'cable'),
    ('Lateral Raise',   'dumbbell'),
    ('Shoulder Press',  'dumbbell'),
    ('Squat',           'barbell'),
    ('Tricep Pushdown', 'cable')
  ) AS map(ex_name, equipment_slug)
 WHERE e.name = map.ex_name
   AND q.slug = map.equipment_slug
   AND e.source_id IS NULL AND e.organization_id IS NULL AND e.deleted_at IS NULL
   AND e.equipment = 'Bodyweight';


-- ─── 3. CARDIO BELONGS IN THE CARDIO REGION ──────────────────
-- The dataset files a treadmill run under "quadriceps", which put every cardio
-- exercise in Legs and left the Cardio filter showing only the mis-filed seeds.
-- The leg muscle is kept as a secondary mover so "what also trains quads" still
-- finds it; the legacy-sync trigger then rewrites target_muscle / muscle_group.
UPDATE exercise_muscles em
   SET role = 'secondary'
  FROM exercises e, exercise_categories c, muscles m
 WHERE em.exercise_id = e.id AND em.role = 'primary'
   AND c.id = e.category_id AND c.slug = 'cardio'
   AND m.id = em.muscle_id AND m.body_region <> 'Cardio'
   AND e.organization_id IS NULL AND e.deleted_at IS NULL;

UPDATE exercises e
   SET primary_muscle_id = m.id
  FROM exercise_categories c, muscles m
 WHERE c.id = e.category_id AND c.slug = 'cardio'
   AND m.slug = 'cardiovascular'
   AND e.primary_muscle_id IS DISTINCT FROM m.id
   AND e.organization_id IS NULL AND e.deleted_at IS NULL;

INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT e.id, e.primary_muscle_id, 'primary'
  FROM exercises e JOIN exercise_categories c ON c.id = e.category_id
 WHERE c.slug = 'cardio' AND e.primary_muscle_id IS NOT NULL
   AND e.organization_id IS NULL AND e.deleted_at IS NULL
ON CONFLICT (exercise_id, muscle_id) DO UPDATE SET role = 'primary';


-- ─── 4. TRACKING MODE FOR EVERY BUILT-IN EXERCISE ────────────
-- Ordered most-specific first. Names are the only signal the dataset carries
-- for holds/carries/conditioning; the lists were checked row by row against
-- the 890-row production library before this was written.
WITH classified AS (
  SELECT e.id,
    CASE
      WHEN c.slug = 'stretching' THEN 'HOLD'
      WHEN e.name ~* '(plank|isometric|wall sit|l-sit|hollow hold|dead hang|side bridge|one handed hang|flexed arm hang)'
       AND e.name !~* '(push ?-?up|wipers|jack)'                                    THEN 'HOLD'
      WHEN e.name ~* '(farmer|yoke walk|rickshaw carry|carry|sled push|sled drag|backward drag|forward drag|bear crawl sled|prowler|sled overhead backward walk)'
                                                                                    THEN 'DISTANCE_LOAD'
      WHEN e.name ~* '(mountain climber|skipping|wind sprint|sprint drill|jumping jack|battl(e|ing) rope|high knees|butt kick|shuttle run|bench sprint|hop-sprint)'
                                                                                    THEN 'TIME'
      WHEN e.name ~* 'sledgehammer'                                                 THEN 'REPS'
      WHEN e.equipment IN ('Bodyweight','Exercise Ball','Suspension Trainer','Foam Roller')
       AND e.name !~* 'weighted'                                                    THEN 'BODYWEIGHT'
      WHEN c.slug = 'plyometrics' AND e.equipment = 'Other'                         THEN 'BODYWEIGHT'
      WHEN e.equipment = 'Other' AND e.name !~* 'weighted'
       AND e.name ~* '(pull-?ups?|chin|dips?\M|muscle up|suspended|rope climb|otis|london bridge|hyperextension|parallel bars|ab roller|inverted row|bodyweight|hamstring slides|band assisted|balance board|box squat|donkey calf)'
                                                                                    THEN 'BODYWEIGHT'
      WHEN e.equipment = 'Resistance Band'                                          THEN 'REPS'
      ELSE 'WEIGHT_REPS'
    END AS mode
  FROM exercises e
  LEFT JOIN exercise_categories c ON c.id = e.category_id
  WHERE e.organization_id IS NULL
    AND e.deleted_at IS NULL
    AND e.prescription_mode_primary IS NULL
    AND coalesce(c.slug, '') <> 'cardio'
)
UPDATE exercises e
   SET prescription_mode_primary = k.mode,
       prescription_mode_allowed = CASE k.mode
         WHEN 'WEIGHT_REPS'   THEN ARRAY['WEIGHT_REPS']
         WHEN 'BODYWEIGHT'    THEN ARRAY['BODYWEIGHT','WEIGHT_REPS','TIME']
         WHEN 'REPS'          THEN ARRAY['REPS','WEIGHT_REPS']
         WHEN 'HOLD'          THEN ARRAY['HOLD','TIME','BODYWEIGHT']
         WHEN 'DISTANCE_LOAD' THEN ARRAY['DISTANCE_LOAD','TIME_LOAD','DISTANCE','TIME']
         WHEN 'TIME'          THEN ARRAY['TIME','BODYWEIGHT','DISTANCE','INTERVAL','ROUNDS']
       END
  FROM classified k
 WHERE k.id = e.id;


-- ─── 5. RECOMMENDED PRESCRIPTION, REPAIRED ───────────────────
-- Only rows still carrying a value 141 generated ('3-4'/'3-5', '3-8'/'6-10'/'10-15').
UPDATE exercises e SET
  recommended_sets = CASE WHEN e.recommended_sets IN ('3-4','3-5') OR e.recommended_sets IS NULL
                          THEN '1-2' ELSE e.recommended_sets END,
  recommended_reps = CASE WHEN e.recommended_reps IN ('3-8','6-10','10-15') OR e.recommended_reps IS NULL
                          THEN '30-60s hold' ELSE e.recommended_reps END
  FROM exercise_categories c
 WHERE c.id = e.category_id AND c.slug = 'stretching'
   AND e.organization_id IS NULL AND e.deleted_at IS NULL
   AND (e.recommended_reps IN ('3-8','6-10','10-15') OR e.recommended_reps IS NULL);

UPDATE exercises e SET
  recommended_sets = CASE WHEN e.recommended_sets IN ('3-4','3-5') THEN '3' ELSE e.recommended_sets END,
  recommended_reps = '20-60s hold'
  FROM exercise_categories c
 WHERE c.id = e.category_id AND c.slug <> 'stretching'
   AND e.prescription_mode_primary = 'HOLD'
   AND e.organization_id IS NULL AND e.deleted_at IS NULL
   AND (e.recommended_reps IN ('3-8','6-10','10-15') OR e.recommended_reps IS NULL);

UPDATE exercises SET
  recommended_sets = CASE WHEN recommended_sets IN ('3-4','3-5') THEN '3-5' ELSE recommended_sets END,
  recommended_reps = '20-40 m'
 WHERE prescription_mode_primary = 'DISTANCE_LOAD'
   AND organization_id IS NULL AND deleted_at IS NULL
   AND (recommended_reps IN ('3-8','6-10','10-15') OR recommended_reps IS NULL);

UPDATE exercises SET
  recommended_sets = CASE WHEN recommended_sets IN ('3-4','3-5') THEN '3-5' ELSE recommended_sets END,
  recommended_reps = '20-40s'
 WHERE prescription_mode_primary = 'TIME'
   AND organization_id IS NULL AND deleted_at IS NULL
   AND exercise_type IS DISTINCT FROM 'Cardio'
   AND (recommended_reps IN ('3-8','6-10','10-15') OR recommended_reps IS NULL);

-- Competition lifts are programmed heavy; 141 meant 3-5 and never matched.
UPDATE exercises e SET recommended_reps = '3-5'
  FROM exercise_categories c
 WHERE c.id = e.category_id AND c.slug IN ('powerlifting','olympic-weightlifting')
   AND e.recommended_reps = '6-10'
   AND e.organization_id IS NULL AND e.deleted_at IS NULL;


ALTER TABLE exercises ENABLE TRIGGER exercises_version_history;


-- ─── 6. ASSERT ───────────────────────────────────────────────
-- Every live built-in exercise now has a mode. A populated library that still
-- has gaps means a rule above silently missed; fail the deploy rather than
-- ship a half-classified library.
DO $$
DECLARE missing INT;
BEGIN
  SELECT count(*) INTO missing FROM exercises
   WHERE organization_id IS NULL AND deleted_at IS NULL AND prescription_mode_primary IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION '221: % built-in exercises still have no tracking mode', missing;
  END IF;
END $$;
