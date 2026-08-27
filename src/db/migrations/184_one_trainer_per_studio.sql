-- ============================================================================
-- 184_one_trainer_per_studio.sql
--
-- The product is being simplified to a fixed shape per studio: one owner, one
-- trainer, many clients. This migration is the database half of that, and it
-- is much smaller than it was originally scoped to be, for a good reason.
--
-- ── What production actually looks like (read 26 Aug 2026) ──────────────────
--
-- All six studios ALREADY have exactly one active trainer and exactly one
-- active admin:
--
--   Abhishek PT Studio     1 trainer  1 admin   admin.trainer_id IS NULL
--   ADVENTURE PT STUDIO    1 trainer  1 admin   linked
--   Ayush PT Studio        1 trainer  1 admin   linked
--   NK FITNESS            1 trainer  1 admin   linked
--   Sachin PT Studio       1 trainer  1 admin   linked
--   Vivek Verma Fitness    1 trainer  1 admin   linked
--
-- So there is nothing to convert. The original design for this migration
-- archived surplus trainers and repointed their clients, leads and future
-- bookings onto a survivor. None of that is written here, because none of it
-- has any work to do. That machinery is documented in the plan if a future
-- database ever needs it.
--
-- What IS left is two things:
--
--   1. One studio's owner is not linked to its trainers row. Abhishek PT
--      Studio's admin is `usr-admin-001` — a hand-made id where every other
--      studio has a UUID — so that account was seeded rather than created
--      through the signup path, and signup is what sets trainer_id
--      (super-admin/organizations.js:113-124). The studio does have an active
--      trainer, "Abhishek Katiyar", the same person; the link is simply absent.
--
--      Nothing is visibly broken today because resolveMyTrainerIds
--      (pt-os.routes.js:1279-1299) falls through to an email match. That
--      fallback is carrying the account, which is exactly the kind of thing
--      that works until the email changes.
--
--   2. Nothing stops a second trainer being created tomorrow. A partial unique
--      index fixes that permanently.
--
-- ── Why this DOES RAISE EXCEPTION ──────────────────────────────────────────
--
-- migrate.js:122-131 wraps each migration in its own transaction and rethrows
-- on failure, and server.js runs migrations before it serves traffic. A
-- migration that throws therefore does not just fail — it stops the deploy.
--
-- This one throws anyway, if it cannot build the index.
--
-- The database invariant is the final authority. The TRAINER_LIMIT guard on
-- the two creation routes is not a substitute for it: it cannot close the race
-- between two concurrent creates that both read zero active trainers before
-- either inserts, and it does not cover writes that never pass through those
-- routes — a psql session, a restored backup, a support script, a route added
-- later by someone who does not know the rule exists.
--
-- So a constraint that is silently absent is worse than a deploy that stops.
-- Nothing downstream can tell the two apart: the code, the tests and the next
-- engineer all read `trainers_one_active_per_org` in the migration and assume
-- it is there. A deploy that stops is loud, and the log says which studio to
-- fix and how.
--
-- The cost is real and worth stating plainly: if a studio ever does acquire a
-- second active trainer, the next deploy's instance refuses to start until a
-- human archives one. That is the intended behaviour, not an oversight.
--
-- Production has exactly one active trainer in every studio today, so this
-- passes cleanly. See the census above.
--
-- ── The order of the sections below matters ────────────────────────────────
--
-- The per-studio report runs BEFORE the index, not after. RAISE NOTICE and
-- RAISE WARNING are sent to the client as they execute and are not rolled
-- back, and migrate.js subscribes to them (migrate.js:59), so a deploy that
-- aborts here still logs exactly which studios need attention. Reported after
-- the index, that diagnostic would be the one thing the abort suppressed —
-- leaving an operator with a failure and no list.
-- ============================================================================


-- ── 1. Link owners that were never linked to their trainers row ─────────────
--
-- Written as a general rule rather than a one-row patch for the studio that
-- needs it today: it is idempotent, and it is correct for any studio that
-- later shows the same gap (a seeded account, a restored backup).
--
-- The HAVING count(*) = 1 is the safety catch. It fires ONLY where the studio
-- has exactly one active trainer, so there is no question which row the owner
-- should point at. A studio with two active trainers is genuinely ambiguous —
-- picking one would silently make somebody the owner's trainer — and a studio
-- with none has nothing to point at. Both are skipped and reported in step 3.
--
-- Only `trainer_id IS NULL` rows are touched. An owner already pointing at a
-- trainer is left exactly as it is, even if it points somewhere unexpected;
-- overwriting that would be a repoint, not a repair, and this migration does
-- not repoint anything.
DO $$
DECLARE
  linked BIGINT := 0;
  r      RECORD;
BEGIN
  -- Report before acting, so the deploy log names who was changed and to what.
  FOR r IN
    SELECT o.name AS studio, u.email, t.id AS trainer_id, t.name AS trainer_name
      FROM users u
      JOIN organizations o ON o.id = u.organization_id
      JOIN (
        SELECT tr.organization_id, min(tr.id) AS id
          FROM trainers tr
         WHERE tr.deleted_at IS NULL AND tr.status = 'active'
         GROUP BY tr.organization_id
        HAVING count(*) = 1
      ) sole ON sole.organization_id = u.organization_id
      JOIN trainers t ON t.id = sole.id
     WHERE u.role = 'admin' AND u.deleted_at IS NULL AND u.trainer_id IS NULL
     ORDER BY o.name
  LOOP
    RAISE WARNING
      '184: linking owner % of % to trainer % (%). The account was not created '
      'through signup, so it never got the link; resolveMyTrainerIds has been '
      'covering it via the email fallback until now.',
      r.email, r.studio, r.trainer_name, r.trainer_id;
  END LOOP;

  UPDATE users u
     SET trainer_id = sole.id,
         updated_at = NOW()
    FROM (
      SELECT tr.organization_id, min(tr.id) AS id
        FROM trainers tr
       WHERE tr.deleted_at IS NULL AND tr.status = 'active'
       GROUP BY tr.organization_id
      HAVING count(*) = 1
    ) sole
   WHERE u.organization_id = sole.organization_id
     AND u.role = 'admin'
     AND u.deleted_at IS NULL
     AND u.trainer_id IS NULL;

  GET DIAGNOSTICS linked = ROW_COUNT;

  IF linked = 0 THEN
    -- The state a re-run leaves, and the state a healthy database is already in.
    RAISE NOTICE '184: every owner is already linked to their studio trainer — nothing to link.';
  ELSE
    RAISE NOTICE '184: linked % owner(s) to their studio trainer.', linked;
  END IF;
END $$;


-- ── 2. Report what needs a human, BEFORE anything can abort ──────────────
--
-- Runs first so that its output survives an abort in section 3: notices are
-- not transactional, so this list reaches the deploy log either way.
--
-- Nothing here is fixed automatically, and that is deliberate.
--
-- A second owner is not demoted: demoting one silently changes a real person's
-- access, and there is no mechanical way to know which of two admins the studio
-- meant to keep. The OWNER_EXISTS guard stops a third being added; who stays is
-- the operator's call.
--
-- A studio with no active trainer is not given one: there is nothing to point
-- at, and inventing a trainers row would put a person in the product who does
-- not exist.
DO $$
DECLARE
  r       RECORD;
  n_flag  INT := 0;
BEGIN
  FOR r IN
    SELECT o.name AS studio,
           (SELECT count(*) FROM trainers t
             WHERE t.organization_id = o.id AND t.deleted_at IS NULL AND t.status = 'active') AS trainers,
           (SELECT count(*) FROM users u
             WHERE u.organization_id = o.id AND u.role = 'admin' AND u.deleted_at IS NULL) AS admins
      FROM organizations o
     ORDER BY o.name
  LOOP
    IF r.trainers = 0 THEN
      n_flag := n_flag + 1;
      RAISE WARNING
        '184: % has NO active trainer. Nobody can be assigned clients or sessions there, '
        'and its owner cannot be linked. This predates the one-trainer change.', r.studio;
    ELSIF r.trainers > 1 THEN
      n_flag := n_flag + 1;
      RAISE WARNING
        '184: % has % active trainers. This WILL abort the migration in section 3. Archive '
        'the surplus (status=''inactive''), never DELETE — pt_commissions, pt_payouts and '
        'leave_requests all cascade.', r.studio, r.trainers;
    END IF;

    IF r.admins = 0 THEN
      n_flag := n_flag + 1;
      RAISE WARNING '184: % has NO active admin — nobody can administer that studio.', r.studio;
    ELSIF r.admins > 1 THEN
      n_flag := n_flag + 1;
      RAISE WARNING
        '184: % has % active admins. No account is demoted by this migration; decide which '
        'one keeps ownership.', r.studio, r.admins;
    END IF;
  END LOOP;

  IF n_flag = 0 THEN
    RAISE NOTICE '184: every studio has exactly one active trainer and one active admin.';
  ELSE
    RAISE WARNING '184: % studio condition(s) above need a human.', n_flag;
  END IF;
END $$;


-- ── 3. Enforce one active trainer per studio, or refuse to proceed ───────
--
-- Partial rather than a plain UNIQUE: archived trainers (status <> 'active')
-- and soft-deleted ones keep their rows, and a studio may accumulate any
-- number of those. The constraint is only about who is active NOW.
--
-- `status` already carries CHECK (status IN ('active','inactive')) from
-- schema.sql:72-99, so no new column is needed to express "archived".
DO $$
DECLARE
  dupes TEXT;
  n_dup INT := 0;
BEGIN
  IF to_regclass('public.trainers_one_active_per_org') IS NOT NULL THEN
    RAISE NOTICE '184: trainers_one_active_per_org already exists — nothing to build.';
    RETURN;
  END IF;

  SELECT string_agg(x.studio || ' (' || x.n || ')', ', ' ORDER BY x.studio), count(*)
    INTO dupes, n_dup
    FROM (
      SELECT o.name AS studio, count(*) AS n
        FROM trainers t
        JOIN organizations o ON o.id = t.organization_id
       WHERE t.deleted_at IS NULL AND t.status = 'active'
       GROUP BY o.name
      HAVING count(*) > 1
    ) x;

  IF n_dup > 0 THEN
    -- Deliberately fatal. Skipping would leave the rule unenforced while every
    -- reader of this file assumes otherwise; see the header.
    RAISE EXCEPTION
      '184: cannot create trainers_one_active_per_org — % studio(s) have more than one '
      'active trainer: %.', n_dup, dupes
      USING HINT =
        'Archive the surplus in each: UPDATE trainers SET status = ''inactive'' WHERE id = ... '
        'Never DELETE — pt_commissions, pt_payouts and leave_requests all cascade and the '
        'history goes with the row. Re-run the deploy once each studio has exactly one.';
  END IF;

  -- The check above should make this unreachable. It is still handled, because
  -- an INSERT landing between that SELECT and this CREATE is exactly the race
  -- the API guard cannot close — and it is the reason this constraint has to
  -- exist in the database at all. Caught only to say something useful; it
  -- re-raises, so the deploy still stops.
  BEGIN
    CREATE UNIQUE INDEX trainers_one_active_per_org
        ON trainers (organization_id)
     WHERE status = 'active' AND deleted_at IS NULL;
    RAISE NOTICE '184: created trainers_one_active_per_org — one active trainer per studio is now enforced.';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION
        '184: trainers_one_active_per_org could not be created (%). A second active trainer '
        'appeared between the check above and the index build.', SQLERRM
        USING HINT = 'Archive the surplus (status = ''inactive'') and re-run the deploy.';
  END;
END $$;
