-- 160_organization_id_not_null_round_two.sql
--
-- The tables migration 155 could not reach, because their organization_id
-- column did not exist yet when it ran.
--
-- 155 tightened 28 tables and explained why it matters: a write path that
-- fails to stamp organization_id produces a row belonging to nobody —
-- invisible in every studio's queries, present in the table, and reported to
-- the caller as a success. NOT NULL converts that from an invisible orphan
-- into a rejected write at the point the bug happens.
--
-- Three tables gained the column afterwards and never got the same treatment:
--
--   pt_trainers                          migration 143
--   pt_posture_assessments               migration 156
--   pt_mobility_performance_assessments  migration 156
--
-- Verified against a freshly built schema (all 159 migrations applied): these
-- three, plus the two named below, are the only tables in `public` whose
-- organization_id is still nullable outside the documented shared set.
--
-- ── Deliberately NOT in the list ────────────────────────────────────────
--
-- Two tables are nullable on purpose, and tightening either would be the bug
-- rather than the fix. Both are recorded in MEANINGFUL_NULLS_NOT_SHARED in
-- migrations.orgNotNull.test.js, which asserts this migration never reaches
-- them.
--
-- Deliberately NOT added to SHARED_TABLES beside the exercise library, which
-- is where a first draft of this put them. That list answers two questions at
-- once — "may this be tightened?" and "should its NULL rows be visible to
-- EVERY studio?" — because for shared platform content both answers are yes,
-- which is why 157 reuses it for its RLS policy shape. These two answer the
-- first no and the second no as well, so listing them there would have
-- widened their RLS policies as a side effect of documenting a NOT NULL
-- exemption. The 157/158 cross-check caught it.
--
--   studio_registrations   A registration exists BEFORE the organisation it
--                          asks for. It is created `pending` with no org, and
--                          organization_id is filled in only on approval —
--                          see migration 146. NOT NULL would make it
--                          impossible to apply for a studio at all.
--
--   activity_log           Migration 158 backfills each row from the acting
--                          user's organisation and leaves the rest NULL
--                          "rather than guessed at" — those are platform
--                          super-admin actions, which by design have no owning
--                          studio. Its strict RLS policy already hides them
--                          from every tenant, which is correct: they are not a
--                          tenant's rows. The operator console reads them over
--                          the owner connection.
--
-- ── Why this checks before it tightens ──────────────────────────────────
--
-- Same reasoning as 155, and the same shape, deliberately: migrations run as
-- part of the deploy and migrate.js aborts the whole run on the first failure.
-- A bare SET NOT NULL against a table holding one orphan would take the deploy
-- down — turning a data-quality issue into an outage, on a change whose entire
-- purpose is to make data quality visible.
--
-- So each table is tightened ONLY if it currently holds zero NULLs, and skipped
-- with a notice otherwise. Safe to apply to any environment without inspecting
-- it first, and safe to re-run: a table skipped today because it had an orphan
-- can be tightened by re-running once the orphan is assigned.
--
-- pt_trainers is the one most likely to be skipped, and migration 143 says why:
-- it backfilled trainers by shared primary key and then by the studio whose
-- clients they train, and anything still unattributable was left NULL and
-- hidden rather than shown to every studio. Those rows are a known, counted
-- number, not a surprise — and a studio missing a trainer from its roster is
-- exactly the symptom.

DO $$
DECLARE
  t            TEXT;
  null_count   BIGINT;
  tightened    INT := 0;
  skipped      INT := 0;
  already      INT := 0;

  -- Tenant-owned tables whose organization_id arrived after 155 ran.
  targets TEXT[] := ARRAY[
    'pt_trainers',
    'pt_posture_assessments',
    'pt_mobility_performance_assessments'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    -- Not every environment has every table, same to_regclass guard as 155.
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;

    -- Already NOT NULL: nothing to do. Keeps this re-runnable.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t
         AND column_name = 'organization_id' AND is_nullable = 'YES'
    ) THEN
      already := already + 1;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', t)
       INTO null_count;

    IF null_count = 0 THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', t);
      tightened := tightened + 1;
    ELSE
      skipped := skipped + 1;
      -- WARNING, not NOTICE, matching 155: psql and the deploy log surface a
      -- warning where a notice scrolls past. Never EXCEPTION — that would
      -- abort the migration run and the deploy with it, and the orphaned rows
      -- are already invisible to every studio; stopping the release does not
      -- make them visible.
      RAISE WARNING
        '160: % left nullable — % row(s) have no organization_id. They are invisible to every studio already; assign them and re-run this migration to tighten the column.',
        t, null_count;
    END IF;
  END LOOP;

  RAISE NOTICE '160: % tightened, % skipped (orphans present), % already NOT NULL.',
    tightened, skipped, already;
END $$;
