-- ============================================================================
-- 181_trainers_single_source.sql
--
-- `trainers` is the canonical trainer table. `pt_trainers` is a fork of it that
-- nothing has ever written to, and the commission and payout system reads the
-- fork.
--
-- ── The gap ─────────────────────────────────────────────────────────────────
--
-- Every trainer the product creates lands in `trainers`. All four insert sites:
--
--   routes/trainers.js:152                       INSERT INTO trainers
--   modules/pt-os/pt-os.routes.js:164            INSERT INTO trainers
--   platform/super-admin/organizations.js:113    INSERT INTO trainers
--   platform/super-admin/registrations.js:205    INSERT INTO trainers
--
-- There is no `INSERT INTO pt_trainers` anywhere in the repository. The table
-- was populated once, by 018's `INSERT ... SELECT ... FROM trainers`, and never
-- again. Migration 145 checked production and found the result:
--
--   trainers      6 rows
--   pt_trainers   0 rows
--
-- Meanwhile fifteen queries across pt-os.routes.js and pt-os.service.js read
-- `pt_trainers` as their only source. Because the join is an INNER JOIN in the
-- one that matters most, the effect is not an error — it is absence:
--
--   commission generation      no pt_commissions row is ever produced
--   the payout table           always empty
--   PUT /commissions/:id       404 "Trainer not found" for every trainer
--   PUT /payouts/:id           404, same
--   the PT dashboard           trainer stats always empty
--   trainer-performance        always empty
--   today's sessions           trainer_name always NULL
--   the session leaderboard    always empty
--
-- 145 fixed the half of this that was a constraint — pt_commissions.trainer_id
-- and pt_payouts.trainer_id now reference `trainers`, so the writes are no
-- longer rejected. It did not touch the queries, so nothing produces the writes.
-- This migration and the change alongside it close the other half.
--
-- ── What this migration does, and what it refuses to do ─────────────────────
--
-- It makes `trainers` a superset, so that switching every read to it cannot
-- lose a person:
--
--   1. any pt_trainers row with no counterpart in `trainers` is copied across,
--      keeping its id — so pt_commissions / pt_payouts / pt_sessions rows that
--      point at it stay valid, and the FKs 145 repointed at `trainers` start
--      resolving instead of dangling.
--
--   2. incentive_rate divergences are REPORTED, never overwritten. The
--      commission editor wrote to pt_trainers and the trainer editor wrote to
--      `trainers`, so where the two disagree there is no mechanical way to
--      know which the studio meant. Picking one with a COALESCE would silently
--      change somebody's pay. The ids and both values go to the deploy log for
--      a human to settle.
--
-- It does NOT drop `pt_trainers`. Dropping it is a separate change, made after
-- this one has been observed in production for a full payout cycle, and it is
-- not required for the fix: once nothing reads the table, an empty table left
-- in place costs nothing.
--
-- On a production database where pt_trainers is empty, every statement below is
-- a no-op and the whole file is an audit record. That is the expected outcome,
-- and the reason it is written to be correct when the table is NOT empty is
-- that migration 171 exists — it backfills organization_id on pt_trainers,
-- which only makes sense in an environment where the table had rows.
-- ============================================================================


-- ── 1. Copy across any trainer that exists only in the fork ─────────────────
--
-- Column-by-column rather than SELECT *: `trainers` is a superset (it adds dob,
-- gender, address, role, salary, branch_id, notes, biometric_*), and the
-- columns it does not share need their defaults, not NULLs.
--
-- The id is preserved. That is the load-bearing part — pt_commissions,
-- pt_payouts and pt_sessions all hold trainer ids, and 145 pointed their
-- foreign keys at `trainers`. A copy under a fresh id would leave every one of
-- those rows orphaned while looking like a successful migration.
DO $$
DECLARE
  copied BIGINT := 0;
BEGIN
  IF to_regclass('public.pt_trainers') IS NULL THEN
    RAISE NOTICE '181: pt_trainers does not exist — nothing to consolidate';
    RETURN;
  END IF;

  INSERT INTO trainers (
    id, name, email, mobile, specialization, bio, schedule, certifications,
    incentive_rate, status, joining_date, photo_url, deleted_at,
    created_at, updated_at, organization_id
  )
  SELECT
    pt.id, pt.name, pt.email, pt.mobile, pt.specialization, pt.bio, pt.schedule,
    pt.certifications, pt.incentive_rate, pt.status, pt.joining_date,
    pt.photo_url, pt.deleted_at, pt.created_at, pt.updated_at, pt.organization_id
  FROM pt_trainers pt
  WHERE NOT EXISTS (SELECT 1 FROM trainers t WHERE t.id = pt.id)
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS copied = ROW_COUNT;

  IF copied > 0 THEN
    RAISE WARNING
      '181: copied % trainer(s) that existed only in pt_trainers into trainers, '
      'keeping their ids. They were invisible to /api/trainers and to every '
      'non-PT screen until now. Check their studio attribution.',
      copied;
  ELSE
    -- Either the fork is empty (the production case) or every row in it
    -- already has a counterpart, which is also the state a re-run leaves.
    RAISE NOTICE '181: no pt_trainers-only rows to copy — every fork row already exists in trainers';
  END IF;
END $$;


-- ── 2. Report incentive_rate divergences — do not resolve them ──────────────
--
-- Deliberately a report and not an UPDATE. See the header: the two editors
-- wrote to different tables, so a disagreement is a genuine ambiguity and the
-- wrong answer changes somebody's pay without telling anyone.
--
-- After this migration, commissions are calculated from `trainers.incentive_rate`.
-- So a divergence reported here means: the rate the studio last set through
-- PT OS → Commissions is NOT the rate that will now be used, until a human
-- reconciles it. That is worth a WARNING with the ids in it.
DO $$
DECLARE
  r          RECORD;
  divergent  INT := 0;
BEGIN
  IF to_regclass('public.pt_trainers') IS NULL THEN RETURN; END IF;

  FOR r IN
    SELECT t.id, t.name,
           t.incentive_rate  AS trainers_rate,
           pt.incentive_rate AS pt_trainers_rate
      FROM trainers t
      JOIN pt_trainers pt ON pt.id = t.id
     WHERE t.incentive_rate IS DISTINCT FROM pt.incentive_rate
       AND t.deleted_at IS NULL
     ORDER BY t.name
  LOOP
    divergent := divergent + 1;
    RAISE WARNING
      '181: trainer % (%) has incentive_rate % in trainers and % in pt_trainers. '
      'Commissions will now use the trainers value. Set it deliberately if that is wrong.',
      r.name, r.id, r.trainers_rate, r.pt_trainers_rate;
  END LOOP;

  IF divergent = 0 THEN
    RAISE NOTICE '181: no incentive_rate divergences between the two tables';
  ELSE
    RAISE WARNING '181: % trainer(s) need their commission rate confirmed by a human.', divergent;
  END IF;
END $$;


-- ── 3. State the end position ───────────────────────────────────────────────
--
-- After steps 1 and 2, `trainers` contains every trainer that either table knew
-- about. The code change shipped with this migration switches all fifteen reads
-- to it, which is safe precisely because of that property — so it is asserted
-- here rather than assumed.
DO $$
DECLARE
  orphans BIGINT := 0;
  n_tr    BIGINT;
BEGIN
  SELECT count(*) INTO n_tr FROM trainers WHERE deleted_at IS NULL;

  IF to_regclass('public.pt_trainers') IS NOT NULL THEN
    SELECT count(*) INTO orphans
      FROM pt_trainers pt
     WHERE NOT EXISTS (SELECT 1 FROM trainers t WHERE t.id = pt.id);
  END IF;

  IF orphans > 0 THEN
    -- Should be unreachable: step 1 just copied exactly these. Reaching it means
    -- the INSERT was rejected (a CHECK constraint on status, most likely), and
    -- those trainers would vanish from PT OS when the reads switch over.
    RAISE WARNING
      '181: % pt_trainers row(s) STILL have no counterpart in trainers after the copy. '
      'They will not appear anywhere once the code reads trainers alone. Investigate before deploying.',
      orphans;
  END IF;

  RAISE NOTICE '181: trainers is now the single source — % live trainer(s), % unconsolidated.',
    n_tr, orphans;
END $$;
