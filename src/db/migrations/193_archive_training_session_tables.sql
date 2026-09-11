-- ============================================================
-- 193_archive_training_session_tables.sql
-- Retire the training domain's session half. workout_sessions is canonical.
-- ============================================================
--
-- ── What this retires, and why it is not a coin toss ────────────────────────
--
-- Two subsystems recorded "a client did a workout on a date":
--
--   pt-os workout log   workout_sessions → workout_session_exercises
--                       → workout_sets              (canonical)
--   training domain     training_sessions → exercise_performances
--                       → set_performances, plus personal_records
--
-- 165 built the second and 167 copied the first into it. server.js said the
-- cutover would follow: "slice G repoints the old path once nothing reads it".
-- It never did, and production answered the other way round.
--
-- Measured before this migration was written:
--
--   workout_sessions    123 rows,  83 in the last 30 days, newest 2026-09-02
--   training_sessions    48 rows,   8 in the last 30 days, newest 2026-08-14
--   exercise_performances 41 rows,  0 in the last 30 days
--   workout_assignments  49 rows  ·  training_assignments 0 rows
--
-- And the decisive one — provenance:
--
--   training_sessions      48 of 48 carry metadata->>'migrated_from'
--   exercise_performances  41 of 41 carry metadata->>'migrated_from'
--   set_performances      100 of 100 carry client_token LIKE 'legacy:%'
--
-- Not one row on this side was ever created by its own API. Every row is a
-- copy made by 167, and the table it was copied FROM is still live and still
-- growing. personal_records holds 43 rows derived from those copies by
-- scripts/backfill-training-records.js, which goes with them.
--
-- So this is not two systems being merged. It is one system and one staging
-- copy of it, and the copy is what goes.
--
-- ── Archived, not dropped ──────────────────────────────────────────────────
--
-- The tables move to the `archive` schema with every row and constraint
-- intact. Nothing is deleted. The six form a closed subgraph — all nine of
-- their foreign keys point at each other and none at anything outside — so
-- they move as a unit and the relationships between them survive the move.
--
-- They leave `public` because that is what stops a future query finding them
-- by accident: a table that is merely unused gets used again.
--
-- ── The templates half stays ───────────────────────────────────────────────
--
-- /api/training/programs, /templates and /meta are untouched and still serve
-- the frontend (api.training.templates, 9 call sites). Only the session
-- surface is gone.
--
-- ── No BEGIN/COMMIT here, deliberately ─────────────────────────────────────
--
-- migrate.js wraps every migration together with the `INSERT INTO _migrations`
-- that records it. A migration that opens its own transaction closes the
-- runner's early. Enforced by migrations.transactionControl.test.js.

-- ------------------------------------------------------------
-- 1. Refuse if any row here was ever created natively.
--
--    The entire argument for retiring this side rather than the other is that
--    it holds no original data. If that stopped being true between writing
--    this and running it, the argument is wrong and the migration must say so
--    rather than quietly archive a studio's real training history.
-- ------------------------------------------------------------
DO $$
DECLARE n BIGINT;
BEGIN
  IF to_regclass('public.training_sessions') IS NULL THEN
    RAISE NOTICE '193: training session tables already archived — nothing to do';
    RETURN;
  END IF;

  EXECUTE $q$SELECT count(*) FROM public.training_sessions
              WHERE metadata->>'migrated_from' IS NULL$q$ INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      '193 refused: public.training_sessions holds % row(s) with no migration provenance. Those were created by /api/training/sessions, not copied by 167, so this side is in real use and archiving it would lose data. Reconcile them against workout_sessions before re-running.', n;
  END IF;

  EXECUTE $q$SELECT count(*) FROM public.exercise_performances
              WHERE metadata->>'migrated_from' IS NULL$q$ INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      '193 refused: public.exercise_performances holds % natively-created row(s).', n;
  END IF;

  EXECUTE $q$SELECT count(*) FROM public.set_performances
              WHERE client_token IS NULL OR client_token NOT LIKE 'legacy:%'$q$ INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      '193 refused: public.set_performances holds % natively-logged row(s).', n;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Refuse if anything outside the retiring set points into it.
--
--    Read from the catalog rather than asserted from memory: the six tables
--    were a closed subgraph when this was written, and a foreign key added
--    since would be silently broken by the move.
-- ------------------------------------------------------------
DO $$
DECLARE offender TEXT;
BEGIN
  IF to_regclass('public.training_sessions') IS NULL THEN RETURN; END IF;

  SELECT string_agg(format('%s.%s → %s', src.relname, con.conname, tgt.relname), ', ')
    INTO offender
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
   WHERE con.contype = 'f'
     AND tgt.relnamespace = 'public'::regnamespace
     AND tgt.relname = ANY (ARRAY['training_sessions','exercise_performances',
                                  'set_performances','cardio_performances',
                                  'personal_records','training_assignments'])
     AND src.relname <> ALL (ARRAY['training_sessions','exercise_performances',
                                   'set_performances','cardio_performances',
                                   'personal_records','training_assignments']);

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      '193 refused: something outside the retiring set references it (%). Archiving would break that reference.', offender;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Move them, rows and constraints intact.
--
--    SET SCHEMA is a catalog operation: it rewrites no data, and the foreign
--    keys between these six follow their tables, so the archived subgraph is
--    still internally consistent and still queryable as `archive.<table>`.
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS archive;

COMMENT ON SCHEMA archive IS
  'Retired tables kept for their data. Nothing in the application reads this schema; see the migration that moved each table in for why it was retired.';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['personal_records','set_performances','cardio_performances',
                           'exercise_performances','training_sessions','training_assignments']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA archive', t);
      RAISE NOTICE '193: archived public.% ', t;
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 4. Verify the end state rather than assume it.
-- ------------------------------------------------------------
DO $$
DECLARE t TEXT; n BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY['training_sessions','exercise_performances','set_performances',
                           'cardio_performances','personal_records','training_assignments']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      RAISE EXCEPTION '193 failed: public.% still exists after the move', t;
    END IF;
    IF to_regclass('archive.' || t) IS NULL THEN
      RAISE EXCEPTION '193 failed: archive.% is missing — the move lost a table', t;
    END IF;
  END LOOP;

  -- The canonical side must be untouched.
  IF to_regclass('public.workout_sessions') IS NULL THEN
    RAISE EXCEPTION '193 failed: public.workout_sessions is missing — the canonical table must survive';
  END IF;
  IF to_regclass('public.pt_sessions') IS NULL THEN
    RAISE EXCEPTION '193 failed: public.pt_sessions is missing — the appointment model is a separate concern and must survive';
  END IF;

  -- And the rows must have come with the tables.
  EXECUTE 'SELECT count(*) FROM archive.training_sessions' INTO n;
  RAISE NOTICE '193: % training session row(s) preserved in archive', n;
END $$;
