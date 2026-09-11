-- ============================================================
-- 195_archive_training_program_tables.sql
-- Retire the training domain's prescription half. workout_plans is canonical.
-- ============================================================
--
-- The companion to 193. That migration retired the training domain's session
-- half after production answered which of the two logging stacks was real;
-- this one retires the authoring half for the same reason, measured the same
-- way. Together they close the Training OS cutover that TRAINING-OS.md §4 left
-- open — in the direction the data chose, not the one the plan assumed.
--
-- ── Two ways to author a workout, and only one of them reaches a client ─────
--
--   legacy      workout_plans → workout_exercises
--   training    training_programs → training_program_phases
--                                 → training_program_weeks
--                                 → workout_templates
--                                 → workout_template_exercises
--
-- Measured before this migration was written:
--
--   workout_plans                60 rows (40 templates), newest 2026-09-02
--   workout_exercises           409 rows
--   training_programs             0 rows
--   training_program_phases       0 rows
--   training_program_weeks        0 rows
--   workout_templates             1 row,  newest 2026-08-28
--   workout_template_exercises    4 rows
--
-- ── The decisive fact is not the row count, it is the downstream ────────────
--
-- 193 archived training_assignments. Nothing else ever referenced
-- workout_templates. So as of 193 the templates half has no path to a client
-- at all: a template can be authored and then nothing in the system can
-- assign it, schedule it, or log against it. It is a builder whose output
-- has nowhere to go.
--
-- The legacy half, meanwhile, carries the whole live chain:
--
--   workout_plans ← workout_assignments (49) ← workout_sessions (123)
--                 ← workout_session_exercises (185) ← workout_sets (514)
--
-- Keeping the templates half as canonical would mean rebuilding assignment
-- and logging on top of it — writing the third workout system to fix having
-- two. Retiring it deletes a dead end. Only one of those is a consolidation.
--
-- ── What the single surviving template says about itself ────────────────────
--
-- All four of its prescriptions are the builder's untouched defaults — three
-- sets of ten, order_index 0, no rest, no load, no RPE — and one of them is
-- "Treadmill Running" stored as WEIGHT_REPS 3×10. The schema in 164 was
-- justified precisely so that a treadmill run would stop being recorded as
-- three sets of twelve. The one row ever written to it records a treadmill
-- run as three sets of ten. It is somebody trying the builder out, not a
-- programme, and it is archived rather than converted: manufacturing a
-- workout_plan from it would put test data into a trainer's live plan list.
--
-- ── Archived, not dropped ──────────────────────────────────────────────────
--
-- Same disposal as 193. The five tables move to the `archive` schema with
-- every row, constraint and index intact; nothing is deleted and the move
-- rewrites no data. They leave `public` because a table that is merely unused
-- gets used again.
--
-- The move also repairs something 193 left behind. Three archived tables
-- (training_assignments, training_sessions, exercise_performances) still hold
-- foreign keys pointing back into public.workout_templates,
-- public.training_programs and public.workout_template_exercises. After this
-- migration the whole training domain — both halves — sits in one schema and
-- those references are internal again.
--
-- ── What is NOT touched ────────────────────────────────────────────────────
--
--   exercises and its lookup tables   the shared library both halves read
--   workout_plans, workout_exercises  the canonical prescription
--   workout_assignments               the canonical assignment
--   workout_sessions, _exercises, _sets   the canonical log
--   pt_sessions                       the appointment model, a separate concern
--
-- ── No BEGIN/COMMIT here, deliberately ─────────────────────────────────────
--
-- migrate.js wraps every migration together with the `INSERT INTO _migrations`
-- that records it. A migration that opens its own transaction closes the
-- runner's early. Enforced by migrations.transactionControl.test.js.

-- ------------------------------------------------------------
-- 1. Refuse if a real programme was built here.
--
--    Archiving is not data loss — the rows survive intact and readable — so
--    the bar for refusing is not "are there rows", it is "has somebody done
--    periodisation work here that they would expect to find in the app
--    tomorrow". A training_programs row is exactly that: phases, weeks and
--    the days hung off them. There are none today. If there are any when
--    this runs, the premise above is wrong and a human has to decide.
--
--    Templates are counted and reported rather than refused on. One stray
--    template is what production has, and a second one appearing during the
--    deploy window is not a reason to fail a deploy.
-- ------------------------------------------------------------
DO $$
DECLARE n BIGINT;
BEGIN
  IF to_regclass('public.training_programs') IS NULL THEN
    RAISE NOTICE '195: training program tables already archived — nothing to do';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.training_programs' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      '195 refused: public.training_programs holds % programme(s). This migration was written against zero, on the basis that nothing was ever authored here. A programme means phases, weeks and workout days that a trainer expects to still be there. Reconcile them against workout_plans before re-running.', n;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.workout_templates' INTO n;
  RAISE NOTICE '195: archiving % workout template(s), none of them assignable since 193', n;
END $$;

-- ------------------------------------------------------------
-- 2. Refuse if anything still in `public` points into the retiring set.
--
--    Read from the catalog rather than asserted from memory. The five were a
--    closed subgraph within public when this was written — every inbound key
--    came either from one of the five or from the `archive` schema, and the
--    archive ones are the point. A key added since, from a live table, would
--    be silently broken by the move.
-- ------------------------------------------------------------
DO $$
DECLARE offender TEXT;
BEGIN
  IF to_regclass('public.training_programs') IS NULL THEN RETURN; END IF;

  SELECT string_agg(format('%s.%s → %s', src.relname, con.conname, tgt.relname), ', ')
    INTO offender
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
   WHERE con.contype = 'f'
     AND src.relnamespace = 'public'::regnamespace
     AND tgt.relnamespace = 'public'::regnamespace
     AND tgt.relname = ANY (ARRAY['training_programs','training_program_phases',
                                  'training_program_weeks','workout_templates',
                                  'workout_template_exercises'])
     AND src.relname <> ALL (ARRAY['training_programs','training_program_phases',
                                   'training_program_weeks','workout_templates',
                                   'workout_template_exercises']);

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      '195 refused: a live public table references the retiring set (%). Archiving would break that reference.', offender;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Move them, rows and constraints intact.
--
--    Children before parents, so that at no point does a table sitting in
--    public depend on one that has already left. SET SCHEMA is a catalog
--    operation: no data is rewritten and the foreign keys between these five
--    follow their tables.
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS archive;

COMMENT ON SCHEMA archive IS
  'Retired tables kept for their data. Nothing in the application reads this schema; see the migration that moved each table in for why it was retired.';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['workout_template_exercises','workout_templates',
                           'training_program_weeks','training_program_phases',
                           'training_programs']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA archive', t);
      RAISE NOTICE '195: archived public.%', t;
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 4. Verify the end state rather than assume it.
-- ------------------------------------------------------------
DO $$
DECLARE t TEXT; n BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY['training_programs','training_program_phases',
                           'training_program_weeks','workout_templates',
                           'workout_template_exercises']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      RAISE EXCEPTION '195 failed: public.% still exists after the move', t;
    END IF;
    IF to_regclass('archive.' || t) IS NULL THEN
      RAISE EXCEPTION '195 failed: archive.% is missing — the move lost a table', t;
    END IF;
  END LOOP;

  -- The canonical chain must be untouched, end to end.
  FOREACH t IN ARRAY ARRAY['workout_plans','workout_exercises','workout_assignments',
                           'workout_sessions','workout_session_exercises','workout_sets',
                           'exercises']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '195 failed: public.% is missing — the canonical chain must survive', t;
    END IF;
  END LOOP;

  EXECUTE 'SELECT count(*) FROM archive.workout_template_exercises' INTO n;
  RAISE NOTICE '195: % template prescription row(s) preserved in archive', n;
END $$;
