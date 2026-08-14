-- ============================================================
-- 164_training_domain_programs.sql
-- Training OS, part 1 of 3: the prescription side.
--
--   training_programs         a block of training for one client
--   training_program_phases   accumulation / strength / peak
--   training_program_weeks    week 1..N, optionally inside a phase
--   workout_templates         one day: "Push A", "Cardio Day"
--   workout_template_exercises  what that day prescribes
--
-- Parts 2 and 3 (165, 166) add execution and personal records.
--
-- ── Why new tables rather than ALTERing the old ones ────────────────────────
--
-- The existing shape cannot express what this domain needs, and the reason is
-- structural rather than a missing column:
--
--   · workout_exercises.sets and .reps are NOT NULL DEFAULT 3/12, so the
--     schema FORCES every prescription to claim sets and reps. A treadmill
--     run is currently stored as "3 sets of 12" — which is what the app
--     shows today for Jump Rope, and it is not a display bug.
--   · There is no prescription_type at all. Everything is implicitly
--     sets×reps, so there is nowhere to say "this one is 20 minutes at 5%
--     incline".
--   · workout_plans is flat. One plan holds days 1-7 of a single week, and
--     later weeks are derived arithmetically. There is no phase, no week
--     entity, and therefore no periodisation.
--   · There are no sections, so warm-up, main work and cool-down are
--     indistinguishable rows separated only by sort_order.
--
-- Widening the old tables to cover this would leave every historical row
-- claiming a prescription type it never had, and would keep the NOT NULL
-- sets/reps that started the problem.
--
-- ── Additive, and deliberately so ──────────────────────────────────────────
--
-- Nothing here drops, renames or rewrites an existing table. The old
-- workout_* tables keep serving production untouched while the new domain is
-- built on top; the cutover is a later migration, once the services and UI
-- that read these tables exist. A destructive step taken before there is
-- anything to replace the old path with is a step that cannot be reviewed.
--
-- ── UUID keys ──────────────────────────────────────────────────────────────
--
-- New tables use UUID primary keys, matching organizations and the migration
-- 140 lookup tables. The legacy workout_* tables use TEXT keys, and the
-- clients, trainers, users and exercises they reference still do — so the FK
-- columns pointing at those stay TEXT. A mixed-width graph is the honest
-- consequence of not rewriting five unrelated tables in this migration; the
-- alternative is a UUID column that stores a TEXT id and lies about its type.
-- ============================================================

-- ── Programs ────────────────────────────────────────────────────────────────
--
-- client_id is nullable: a program with no client is a reusable template, the
-- role workout_plans.is_template plays today. One nullable column beats a
-- boolean that has to agree with a foreign key.
CREATE TABLE IF NOT EXISTS training_programs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id        TEXT REFERENCES pt_clients(id) ON DELETE CASCADE,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,

  name             TEXT NOT NULL,
  description      TEXT,
  goal             TEXT,
  program_type     TEXT NOT NULL DEFAULT 'GENERAL_FITNESS',
  duration_weeks   INTEGER,
  status           TEXT NOT NULL DEFAULT 'DRAFT',
  start_date       DATE,
  end_date         DATE,
  notes            TEXT,

  -- Genuinely open-ended trainer annotations only. Anything queried — a
  -- filter, a report column, a sort — belongs in a real column.
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,

  archived_at      TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT training_programs_type_check CHECK (program_type IN (
    'GENERAL_FITNESS','FAT_LOSS','MUSCLE_GAIN','STRENGTH','POWERLIFTING',
    'BODYBUILDING','CONDITIONING','SPORT_SPECIFIC','REHAB','CUSTOM'
  )),
  CONSTRAINT training_programs_status_check CHECK (status IN (
    'DRAFT','ACTIVE','PAUSED','COMPLETED','CANCELLED'
  )),
  CONSTRAINT training_programs_weeks_check CHECK (
    duration_weeks IS NULL OR duration_weeks BETWEEN 1 AND 104
  ),
  -- A program that ends before it starts is a typo, not a state.
  CONSTRAINT training_programs_dates_check CHECK (
    start_date IS NULL OR end_date IS NULL OR end_date >= start_date
  )
);

CREATE INDEX IF NOT EXISTS tp_org_status_idx    ON training_programs (organization_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tp_client_idx        ON training_programs (client_id) WHERE deleted_at IS NULL;

-- ── Phases ──────────────────────────────────────────────────────────────────
--
-- Weeks 1-4 accumulation, 5-8 strength, 9-12 peak. week_start/week_end are
-- program-relative week numbers, not dates: a phase describes the programme's
-- shape, and shifting a client's start date must not rewrite every phase.
CREATE TABLE IF NOT EXISTS training_program_phases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   UUID NOT NULL REFERENCES training_programs(id) ON DELETE CASCADE,

  name         TEXT NOT NULL,
  phase_order  INTEGER NOT NULL DEFAULT 1,
  week_start   INTEGER NOT NULL,
  week_end     INTEGER NOT NULL,
  goal         TEXT,
  notes        TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tpp_week_range_check CHECK (week_start >= 1 AND week_end >= week_start)
);

CREATE INDEX IF NOT EXISTS tpp_program_idx ON training_program_phases (program_id, phase_order);

-- ── Weeks ───────────────────────────────────────────────────────────────────
--
-- An explicit row per week, which is the break from the old model. Today a
-- twelve-week block stores one week and derives the rest, so week 7 can only
-- ever be week 1 plus arithmetic — a deload week, or a week that swaps an
-- exercise, cannot be expressed at all. Storing weeks makes both ordinary.
--
-- Progression rules still exist (they generate these rows), but the stored
-- week is the source of truth once written, so a trainer can always overrule
-- the maths.
CREATE TABLE IF NOT EXISTS training_program_weeks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   UUID NOT NULL REFERENCES training_programs(id) ON DELETE CASCADE,
  phase_id     UUID REFERENCES training_program_phases(id) ON DELETE SET NULL,

  week_number  INTEGER NOT NULL,
  name         TEXT,
  notes        TEXT,
  -- A deload is a property of the week, and every progression rule and every
  -- volume chart needs to know about it.
  is_deload    BOOLEAN NOT NULL DEFAULT FALSE,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tpw_week_number_check CHECK (week_number BETWEEN 1 AND 104),
  CONSTRAINT tpw_unique_week UNIQUE (program_id, week_number)
);

CREATE INDEX IF NOT EXISTS tpw_program_idx ON training_program_weeks (program_id, week_number);

-- ── Workout templates ───────────────────────────────────────────────────────
--
-- One trainable day. program_id and week_id are both nullable so the same
-- table serves a standalone template ("Push A", reusable across clients) and
-- a day bound to week 3 of one programme. Two tables for those would mean two
-- of everything downstream — two prescription tables, two builders.
CREATE TABLE IF NOT EXISTS workout_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  program_id       UUID REFERENCES training_programs(id) ON DELETE CASCADE,
  week_id          UUID REFERENCES training_program_weeks(id) ON DELETE CASCADE,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,

  name             TEXT NOT NULL,
  description      TEXT,
  -- Which day within its week. NULL for a standalone template, which belongs
  -- to no week and therefore to no day.
  day_number       INTEGER,
  day_label        TEXT,
  goal             TEXT,
  estimated_duration_minutes INTEGER,
  notes            TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,

  archived_at      TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT wt_day_number_check CHECK (day_number IS NULL OR day_number BETWEEN 1 AND 7),
  -- A day inside a week must say which day it is; a standalone template must
  -- not pretend to.
  CONSTRAINT wt_week_day_agree CHECK (
    (week_id IS NULL AND day_number IS NULL) OR (week_id IS NOT NULL AND day_number IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS wt_org_idx     ON workout_templates (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS wt_program_idx ON workout_templates (program_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS wt_week_idx    ON workout_templates (week_id, day_number) WHERE deleted_at IS NULL;

-- ── The prescription ────────────────────────────────────────────────────────
--
-- The table the whole redesign turns on.
--
-- prescription_type decides which of the target_* columns mean anything. A
-- SETS_REPS row fills target_sets/reps and leaves distance NULL; a
-- TIME_DISTANCE row does the reverse. Nothing is NOT NULL beyond the
-- structural columns, because "which fields apply" is a property of the type
-- and cannot be a property of the table.
--
-- Why wide columns rather than a JSONB blob: every one of these is queried.
-- "Show me every prescription over 80% 1RM", "total prescribed cardio
-- distance this week", "which exercises are prescribed at RPE 9" are all
-- ordinary reporting questions, and a JSONB blob answers them slowly and
-- without type safety. JSONB stays for genuinely open metadata.
--
-- section and superset_group are what the old table lacked entirely, and both
-- are structural: a warm-up row and a main-work row are different things to
-- volume analytics, not just to the eye.
CREATE TABLE IF NOT EXISTS workout_template_exercises (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workout_template_id   UUID NOT NULL REFERENCES workout_templates(id) ON DELETE CASCADE,
  exercise_id           TEXT NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,

  section               TEXT NOT NULL DEFAULT 'MAIN',
  order_index           INTEGER NOT NULL DEFAULT 0,
  -- Two exercises sharing a superset_group are alternated; sharing a
  -- circuit_group are rotated through. Both are labels rather than a join
  -- table, because grouping is per-template and never queried across them.
  superset_group        TEXT,
  circuit_group         TEXT,

  prescription_type     TEXT NOT NULL DEFAULT 'SETS_REPS',

  -- Strength
  target_sets           SMALLINT,
  target_reps_min       SMALLINT,
  target_reps_max       SMALLINT,
  target_weight         NUMERIC(7,2),
  weight_unit           TEXT NOT NULL DEFAULT 'kg',
  target_rpe            NUMERIC(3,1),
  target_rir            SMALLINT,
  target_tempo          TEXT,
  target_rest_seconds   INTEGER,
  percentage_1rm        NUMERIC(5,2),
  percentage_metric     TEXT,

  -- Cardio and time-based. These are the columns the old schema had nowhere
  -- to put, which is why a treadmill run became three sets of twelve.
  target_duration_seconds INTEGER,
  target_distance         NUMERIC(9,3),
  distance_unit           TEXT,
  target_speed            NUMERIC(6,2),
  target_incline          NUMERIC(5,2),
  target_resistance       NUMERIC(5,2),
  target_heart_rate       SMALLINT,
  target_calories         INTEGER,
  target_pace_seconds     INTEGER,

  -- Intervals: EMOM, HIIT, Tabata. Rounds of work and rest, which is a shape
  -- sets/reps cannot represent no matter how the numbers are bent.
  work_interval_seconds   INTEGER,
  rest_interval_seconds   INTEGER,
  target_rounds           SMALLINT,

  warmup                BOOLEAN NOT NULL DEFAULT FALSE,
  optional              BOOLEAN NOT NULL DEFAULT FALSE,
  notes                 TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT wte_section_check CHECK (section IN (
    'WARMUP','ACTIVATION','MAIN','ACCESSORY','CARDIO','CONDITIONING','COOLDOWN','MOBILITY'
  )),
  CONSTRAINT wte_prescription_check CHECK (prescription_type IN (
    'SETS_REPS','WEIGHT_REPS','RPE_BASED','RIR_BASED','PERCENT_1RM',
    'TIME','DISTANCE','TIME_DISTANCE','PACE','SPEED',
    'INTERVAL','AMRAP','EMOM','CIRCUIT','BODYWEIGHT','MOBILITY','CUSTOM'
  )),
  CONSTRAINT wte_weight_unit_check   CHECK (weight_unit IN ('kg','lb')),
  CONSTRAINT wte_distance_unit_check CHECK (distance_unit IS NULL OR distance_unit IN ('m','km','mile')),
  -- RPE 6-10 and RIR 0-5 are different scales; the range admits both so a
  -- studio can use either without the schema taking a side.
  CONSTRAINT wte_rpe_check      CHECK (target_rpe IS NULL OR target_rpe BETWEEN 0 AND 10),
  CONSTRAINT wte_rir_check      CHECK (target_rir IS NULL OR target_rir BETWEEN 0 AND 10),
  CONSTRAINT wte_pct_1rm_check  CHECK (percentage_1rm IS NULL OR percentage_1rm BETWEEN 0 AND 200),
  CONSTRAINT wte_reps_range_check CHECK (
    target_reps_min IS NULL OR target_reps_max IS NULL OR target_reps_max >= target_reps_min
  )
);

CREATE INDEX IF NOT EXISTS wte_template_idx ON workout_template_exercises (workout_template_id, section, order_index);
CREATE INDEX IF NOT EXISTS wte_exercise_idx ON workout_template_exercises (exercise_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- Same two-layer convention as every other table: anon/authenticated are
-- denied outright (the app never connects as either), and app_tenant sees
-- only its own organization.
--
-- The three child tables carry no organization_id — their tenancy is their
-- parent's, exactly as workout_exercises' is today. They still get the
-- deny-all policy so a direct connection cannot read them, and the service
-- layer always reaches them through a parent it has already scoped.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'training_programs','training_program_phases','training_program_weeks',
    'workout_templates','workout_template_exercises'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON public.%I', t);
    -- No TO clause, so the deny applies to every role. app_tenant is still
    -- admitted because permissive policies are OR'd and tenant_isolation
    -- below grants it its own rows.
    EXECUTE format(
      'CREATE POLICY deny_all_direct_access ON public.%I '
      'FOR ALL USING (false) WITH CHECK (false)', t);

    -- The REVOKE half of the convention (rls.convention.test.js enforces it).
    -- RLS alone would deny, so this is defence in depth: it is the layer that
    -- survives someone adding a permissive policy later for one legitimate
    -- case and accidentally widening the table.
    --
    -- Guarded on role existence because anon and authenticated are supplied
    -- by Supabase and do not exist on a plain PostgreSQL — CI and a local dev
    -- database have neither, and an unguarded REVOKE fails the whole file
    -- there. Found by running the migration, not by reading it.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    FOREACH t IN ARRAY ARRAY['training_programs','workout_templates'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant '
        'USING (organization_id::text = current_setting(''app.org_id'', true)) '
        'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))', t);
    END LOOP;
  END IF;
END $$;

COMMENT ON TABLE training_programs IS
  'A block of training. NULL client_id = a reusable template.';
COMMENT ON COLUMN workout_template_exercises.prescription_type IS
  'Decides which target_* columns apply. A TIME_DISTANCE row leaves the '
  'sets/reps columns NULL rather than claiming 3x12, which is what the '
  'legacy workout_exercises table forced.';
