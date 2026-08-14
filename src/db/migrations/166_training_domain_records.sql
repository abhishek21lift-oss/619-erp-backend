-- ============================================================
-- 166_training_domain_records.sql
-- Training OS, part 3 of 3: personal records.
--
-- ── Why a table and not three booleans ─────────────────────────────────────
--
-- Today a PR is `is_pr_weight`, `is_pr_reps`, `is_pr_volume` — three flags on
-- workout_sets, computed at write time by comparing against the client's
-- prior sets. That works for exactly the three questions it names, and:
--
--   · it cannot record a cardio PR at all, because cardio has no set row;
--   · "what is this client's squat PR" means scanning every set they have
--     ever logged and picking the max, on every read;
--   · a flag set on Tuesday stays true forever, so a set that WAS a PR and
--     has since been beaten still reads as one;
--   · there is no estimated 1RM, no best-pace, no longest-distance.
--
-- A record is a fact about a client and an exercise, so it lives on its own
-- row keyed by both, with a pointer back to the performance that set it.
--
-- ── Superseding rather than deleting ───────────────────────────────────────
--
-- Beating a PR does not delete the old one — it marks it superseded and
-- inserts the new one. "Squat 1RM over the last year" is then a query rather
-- than an archaeology exercise, and the partial unique index keeps exactly
-- one current record per (client, exercise, type).
--
-- ── Failing softly ─────────────────────────────────────────────────────────
--
-- Nothing about this table is on the critical path of finishing a workout.
-- PR detection runs after the session is marked complete and, if it throws,
-- the session stays complete. A client who just trained must never be told
-- their workout failed to save because a record calculation had a bad day.
-- ============================================================

CREATE TABLE IF NOT EXISTS personal_records (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id        TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  exercise_id      TEXT REFERENCES exercises(id) ON DELETE SET NULL,

  -- Survives the exercise being archived, exactly as the performance tables do.
  exercise_name    TEXT NOT NULL,
  record_type      TEXT NOT NULL,

  -- One numeric value plus its unit, rather than a column per record type.
  -- The type says what the number means; a MAX_WEIGHT row is kg or lb, a
  -- BEST_DISTANCE row is km or mile, a BEST_TIME row is seconds.
  value            NUMERIC(12,3) NOT NULL,
  unit             TEXT,
  -- The qualifier a strength record needs and a cardio one does not: a 5RM
  -- and a 1RM are different records at the same weight.
  reps             SMALLINT,

  -- Where it came from. SET NULL rather than CASCADE: deleting a session
  -- should not silently erase the client's best lift.
  session_id             UUID REFERENCES training_sessions(id) ON DELETE SET NULL,
  exercise_performance_id UUID REFERENCES exercise_performances(id) ON DELETE SET NULL,
  set_performance_id     UUID REFERENCES set_performances(id) ON DELETE SET NULL,
  cardio_performance_id  UUID REFERENCES cardio_performances(id) ON DELETE SET NULL,

  achieved_on      DATE NOT NULL DEFAULT CURRENT_DATE,
  -- NULL = this is the client's current record for that type.
  superseded_at    TIMESTAMPTZ,
  superseded_by    UUID REFERENCES personal_records(id) ON DELETE SET NULL,

  notes            TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pr_type_check CHECK (record_type IN (
    'MAX_WEIGHT','MAX_REPS','BEST_VOLUME','BEST_1RM_ESTIMATE',
    'BEST_DISTANCE','BEST_TIME','BEST_PACE','BEST_SPEED','MOST_CALORIES'
  )),
  CONSTRAINT pr_unit_check CHECK (unit IS NULL OR unit IN (
    'kg','lb','m','km','mile','seconds','kmh','mph','min_per_km','min_per_mile','reps','kcal'
  )),
  CONSTRAINT pr_value_check CHECK (value >= 0)
);

-- Exactly one live record per client / exercise / type / rep qualifier.
-- COALESCE because NULL reps (a cardio or volume record) must still collide
-- with itself, and NULLs do not compare equal in a plain unique index.
CREATE UNIQUE INDEX IF NOT EXISTS pr_current_uniq
  ON personal_records (client_id, exercise_id, record_type, COALESCE(reps, -1))
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS pr_client_current_idx ON personal_records (client_id, achieved_on DESC) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS pr_org_recent_idx     ON personal_records (organization_id, achieved_on DESC);
CREATE INDEX IF NOT EXISTS pr_exercise_idx       ON personal_records (exercise_id, record_type) WHERE superseded_at IS NULL;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.personal_records ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS deny_all_direct_access ON public.personal_records';
  EXECUTE 'CREATE POLICY deny_all_direct_access ON public.personal_records FOR ALL USING (false) WITH CHECK (false)';

  -- REVOKE as well as RLS — defence in depth, and the half
  -- rls.convention.test.js enforces. Guarded on role existence: anon and
  -- authenticated are Supabase-supplied and absent on a plain PostgreSQL.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.personal_records FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.personal_records FROM authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.personal_records';
    EXECUTE 'CREATE POLICY tenant_isolation ON public.personal_records FOR ALL TO app_tenant '
         || 'USING (organization_id::text = current_setting(''app.org_id'', true)) '
         || 'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))';
  END IF;
END $$;

COMMENT ON TABLE personal_records IS
  'One row per record. Beating a record supersedes the old row rather than '
  'deleting it, so PR history is a query. Replaces the is_pr_* booleans on '
  'workout_sets, which could not represent a cardio record at all.';
