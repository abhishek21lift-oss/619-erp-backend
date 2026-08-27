-- ============================================================
-- 165_training_domain_execution.sql
-- Training OS, part 2 of 3: what actually happened.
--
--   training_assignments   a template handed to a client for a date
--   training_sessions      one attempt at it
--   exercise_performances  one exercise within that attempt
--   set_performances       one set of that exercise
--   cardio_performances    one cardio effort — NOT a set
--
-- ── The split that matters ─────────────────────────────────────────────────
--
-- exercise_performances has TWO kinds of child, and which one a row gets is
-- decided by what was performed, not by a flag:
--
--   Back Squat   → set_performances     (4 rows: weight × reps)
--   Treadmill    → cardio_performances  (1 row: 25 min, 3.2 km, 4% incline)
--   Circuit      → cardio_performances  (rounds, work/rest intervals)
--
-- Today there is only workout_sets, whose columns are weight_kg, reps, rpe,
-- rir and tempo. A treadmill run logged there has to borrow reps to mean
-- minutes, or be recorded as three sets of twelve and lose the run entirely.
-- Distance, incline, pace, heart rate and calories have nowhere to go at all.
-- Splitting the child is the only fix that does not corrupt one modality to
-- store the other.
--
-- A single exercise may have both children — a "row 500m then 10 burpees"
-- complex is one exercise_performance with a cardio row and a set row — so
-- neither table claims exclusivity.
--
-- ── Idempotency ────────────────────────────────────────────────────────────
--
-- set_performances and cardio_performances carry client_token. A phone
-- logging a set on a flaky gym connection retries; without a token the retry
-- writes a second set and the client's volume silently doubles. The token is
-- generated on the device, unique per intended write, and the unique index
-- makes the retry a no-op instead of a duplicate.
-- ============================================================

-- ── Assignment ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_assignments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  program_id          UUID REFERENCES training_programs(id) ON DELETE SET NULL,
  workout_template_id UUID NOT NULL REFERENCES workout_templates(id) ON DELETE RESTRICT,
  client_id           TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  trainer_id          TEXT REFERENCES trainers(id) ON DELETE SET NULL,
  assigned_by         TEXT REFERENCES users(id) ON DELETE SET NULL,

  assigned_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  scheduled_date      DATE,
  status              TEXT NOT NULL DEFAULT 'ASSIGNED',
  sequence_number     INTEGER,
  notes               TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ta_status_check CHECK (status IN (
    'ASSIGNED','SCHEDULED','IN_PROGRESS','COMPLETED','SKIPPED','MISSED','CANCELLED'
  ))
);

-- The roster query: "what is this client doing today". Partial on the open
-- statuses because a finished assignment is never in that answer.
CREATE INDEX IF NOT EXISTS ta_client_sched_idx ON training_assignments (client_id, scheduled_date);
CREATE INDEX IF NOT EXISTS ta_org_sched_open_idx ON training_assignments (organization_id, scheduled_date)
  WHERE status IN ('ASSIGNED','SCHEDULED','IN_PROGRESS');
CREATE INDEX IF NOT EXISTS ta_trainer_idx ON training_assignments (trainer_id, scheduled_date);

-- ── Session ─────────────────────────────────────────────────────────────────
--
-- assignment_id and workout_template_id are both nullable: a client may train
-- off-programme, and that freestyle session is still a session. The old table
-- allowed this too, but only as a NULL assignment on a row that still had to
-- name a program in free text.
CREATE TABLE IF NOT EXISTS training_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id           TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  trainer_id          TEXT REFERENCES trainers(id) ON DELETE SET NULL,
  assignment_id       UUID REFERENCES training_assignments(id) ON DELETE SET NULL,
  workout_template_id UUID REFERENCES workout_templates(id) ON DELETE SET NULL,
  created_by          TEXT REFERENCES users(id) ON DELETE SET NULL,

  session_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  duration_seconds    INTEGER,
  status              TEXT NOT NULL DEFAULT 'NOT_STARTED',

  -- Name snapshot, for the same reason workout_session_exercises snapshots
  -- exercise_name: a template renamed or archived next year must not rewrite
  -- what last year's history says the client did.
  template_name       TEXT,

  client_notes        TEXT,
  trainer_notes       TEXT,
  overall_rpe         NUMERIC(3,1),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,

  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ts_status_check CHECK (status IN (
    'NOT_STARTED','IN_PROGRESS','COMPLETED','ABANDONED'
  )),
  CONSTRAINT ts_rpe_check CHECK (overall_rpe IS NULL OR overall_rpe BETWEEN 0 AND 10),
  CONSTRAINT ts_completed_after_start CHECK (
    started_at IS NULL OR completed_at IS NULL OR completed_at >= started_at
  )
);

CREATE INDEX IF NOT EXISTS tsess_client_date_idx ON training_sessions (client_id, session_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tsess_org_date_idx    ON training_sessions (organization_id, session_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tsess_assignment_idx  ON training_sessions (assignment_id);

-- ── Exercise performance ────────────────────────────────────────────────────
--
-- template_exercise_id is nullable and ON DELETE SET NULL: an exercise added
-- on the floor has no prescription, and deleting a prescription next month
-- must not delete the record of it having been performed.
CREATE TABLE IF NOT EXISTS exercise_performances (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            UUID NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  exercise_id           TEXT REFERENCES exercises(id) ON DELETE SET NULL,
  template_exercise_id  UUID REFERENCES workout_template_exercises(id) ON DELETE SET NULL,

  -- Survives the exercise being archived, renamed or unlinked.
  exercise_name         TEXT NOT NULL,
  section               TEXT,
  order_index           INTEGER NOT NULL DEFAULT 0,

  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'PENDING',
  notes                 TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ep_status_check CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','SKIPPED'))
);

CREATE INDEX IF NOT EXISTS ep_session_idx  ON exercise_performances (session_id, order_index);
-- "What did they last do on this exercise" — the progressive-overload lookup,
-- and the hottest read in the whole client-facing flow.
CREATE INDEX IF NOT EXISTS ep_exercise_idx ON exercise_performances (exercise_id, session_id);

-- ── Set performance ─────────────────────────────────────────────────────────
--
-- planned_* alongside actual_*: the prescription is copied onto the row when
-- the set is created, so "4 × 6 @ 100kg, did 4 × 6 @ 102.5" survives a later
-- edit to the template. Reading the plan through a join would make every past
-- session re-render against today's prescription.
CREATE TABLE IF NOT EXISTS set_performances (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_performance_id  UUID NOT NULL REFERENCES exercise_performances(id) ON DELETE CASCADE,

  set_number     SMALLINT NOT NULL,
  set_type       TEXT NOT NULL DEFAULT 'WORKING',

  planned_reps   SMALLINT,
  actual_reps    SMALLINT,
  planned_weight NUMERIC(7,2),
  actual_weight  NUMERIC(7,2),
  weight_unit    TEXT NOT NULL DEFAULT 'kg',
  planned_rpe    NUMERIC(3,1),
  actual_rpe     NUMERIC(3,1),
  planned_rir    SMALLINT,
  actual_rir     SMALLINT,
  tempo          TEXT,
  rest_seconds   INTEGER,
  duration_seconds INTEGER,

  completed      BOOLEAN NOT NULL DEFAULT FALSE,
  failure        BOOLEAN NOT NULL DEFAULT FALSE,
  notes          TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Device-generated, see the header. NULL is allowed so a server-side write
  -- (a trainer editing history in the console) needs no token.
  client_token   TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT sp_set_type_check CHECK (set_type IN (
    'WARMUP','WORKING','BACKOFF','DROP','AMRAP','FAILURE','CUSTOM'
  )),
  CONSTRAINT sp_weight_unit_check CHECK (weight_unit IN ('kg','lb')),
  CONSTRAINT sp_rpe_check CHECK (actual_rpe IS NULL OR actual_rpe BETWEEN 0 AND 10),
  CONSTRAINT sp_rir_check CHECK (actual_rir IS NULL OR actual_rir BETWEEN 0 AND 10),
  CONSTRAINT sp_reps_nonneg CHECK (actual_reps IS NULL OR actual_reps >= 0),
  CONSTRAINT sp_set_number_check CHECK (set_number BETWEEN 1 AND 99)
);

CREATE INDEX IF NOT EXISTS sp_perf_idx ON set_performances (exercise_performance_id, set_number);
CREATE UNIQUE INDEX IF NOT EXISTS sp_client_token_uniq ON set_performances (client_token) WHERE client_token IS NOT NULL;

-- ── Cardio performance ──────────────────────────────────────────────────────
--
-- The table the old schema had no equivalent of.
--
-- Every column here is one a treadmill, bike, rower or interval block
-- actually produces, and none of them fit in workout_sets. distance is stored
-- with its unit rather than normalised to metres: a studio that programmes in
-- miles should read back miles, and a lossy conversion on write cannot be
-- undone. Conversion happens at the presentation layer.
--
-- pace_seconds is per distance_unit (2:00/500m stores 120 with unit 'm' and
-- pace_distance 500), which is how rowers and runners actually speak.
CREATE TABLE IF NOT EXISTS cardio_performances (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_performance_id  UUID NOT NULL REFERENCES exercise_performances(id) ON DELETE CASCADE,

  cardio_type        TEXT NOT NULL DEFAULT 'OTHER',

  duration_seconds   INTEGER,
  distance           NUMERIC(9,3),
  distance_unit      TEXT,
  average_speed      NUMERIC(6,2),
  max_speed          NUMERIC(6,2),
  speed_unit         TEXT,
  incline            NUMERIC(5,2),
  resistance         NUMERIC(5,2),
  average_heart_rate SMALLINT,
  max_heart_rate     SMALLINT,
  calories_burned    INTEGER,
  pace_seconds       INTEGER,
  pace_distance      NUMERIC(9,3),
  cadence            SMALLINT,
  elevation_gain     NUMERIC(7,2),

  -- Intervals: HIIT, EMOM, circuits.
  work_interval_seconds INTEGER,
  rest_interval_seconds INTEGER,
  rounds_completed      SMALLINT,

  rpe        NUMERIC(3,1),
  completed  BOOLEAN NOT NULL DEFAULT FALSE,
  notes      TEXT,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,

  client_token TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT cp_type_check CHECK (cardio_type IN (
    'TREADMILL','RUNNING','CYCLING','STATIONARY_BIKE','ROWING','ELLIPTICAL',
    'STAIRMASTER','SKI_ERG','SWIMMING','WALKING','HIIT','CIRCUIT','OTHER'
  )),
  CONSTRAINT cp_distance_unit_check CHECK (distance_unit IS NULL OR distance_unit IN ('m','km','mile')),
  CONSTRAINT cp_speed_unit_check    CHECK (speed_unit IS NULL OR speed_unit IN ('kmh','mph','min_per_km','min_per_mile')),
  CONSTRAINT cp_rpe_check      CHECK (rpe IS NULL OR rpe BETWEEN 0 AND 10),
  CONSTRAINT cp_hr_check       CHECK (average_heart_rate IS NULL OR average_heart_rate BETWEEN 20 AND 250),
  CONSTRAINT cp_max_hr_check   CHECK (max_heart_rate IS NULL OR max_heart_rate BETWEEN 20 AND 250),
  CONSTRAINT cp_duration_check CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  CONSTRAINT cp_distance_check CHECK (distance IS NULL OR distance >= 0),
  -- A distance with no unit is a number nobody can read back.
  CONSTRAINT cp_distance_needs_unit CHECK (distance IS NULL OR distance_unit IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS cp_perf_idx ON cardio_performances (exercise_performance_id);
CREATE INDEX IF NOT EXISTS cp_type_idx ON cardio_performances (cardio_type);
CREATE UNIQUE INDEX IF NOT EXISTS cp_client_token_uniq ON cardio_performances (client_token) WHERE client_token IS NOT NULL;

-- ── RLS ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'training_assignments','training_sessions','exercise_performances',
    'set_performances','cardio_performances'
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
    FOREACH t IN ARRAY ARRAY['training_assignments','training_sessions'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant '
        'USING (organization_id::text = current_setting(''app.org_id'', true)) '
        'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))', t);
    END LOOP;
  END IF;
END $$;

COMMENT ON TABLE cardio_performances IS
  'A cardio effort. Deliberately NOT stored as sets/reps: the legacy '
  'workout_sets table has only weight/reps/rpe/rir/tempo, so a treadmill run '
  'logged there loses distance, incline, pace, heart rate and calories.';
COMMENT ON COLUMN set_performances.client_token IS
  'Device-generated idempotency key. A retry on a flaky gym connection must '
  'not write the set twice.';
