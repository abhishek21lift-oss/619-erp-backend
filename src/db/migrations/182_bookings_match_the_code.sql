-- ============================================================================
-- 182_bookings_match_the_code.sql
--
-- The class booking module has never executed a single successful statement.
--
-- ── How that is possible ────────────────────────────────────────────────────
--
-- `bookings` and `class_sessions` have exactly one definition in this
-- repository — migration 015 — and modules/bookings/bookings.service.js was
-- written against a different, later design that was never migrated. Verified
-- by building 015's schema and running the module's own SQL against it:
--
--   GET  /api/classes/sessions   ERROR: column cs.trainer_id does not exist
--                                (also cs.starts_at, cs.ends_at)
--   POST /api/bookings           ERROR: column "membership_id" of relation
--                                "bookings" does not exist
--   a full class → waitlist      ERROR: new row violates check constraint
--                                "bookings_status_check"
--
-- The audit that found this originally reported it as "good code standing on a
-- data model the product never adopted", fixable by repointing the membership
-- lookup. That was too generous: the module also disagrees with the schema
-- about column names, about which columns exist at all, and about the set of
-- legal statuses. It is not a repoint.
--
-- The 402 NO_MEMBERSHIP the audit predicted is real but unreachable — the
-- INSERT fails first, and before either of them GET /api/classes/sessions 500s,
-- so no session id ever reaches the client to book with.
--
-- ── The direction this migration takes, and why ─────────────────────────────
--
-- The code moves to the schema, not the schema to the code, wherever the two
-- describe the same thing:
--
--   starts_at / ends_at   NOT added. `date + start_time` already carries this
--                         exactly, and a stored copy is a denormalisation that
--                         can disagree with its source. The queries compute it
--                         and keep the API's starts_at/ends_at response shape,
--                         which the member Classes screen reads.
--   trainer_id            NOT added. The column is `instructor_id` and always
--                         has been; the queries now say so.
--
-- Only what the schema genuinely lacks is added: the waitlist, the cancellation
-- record, and the check-in method.
--
--   position              waitlist ordering
--   cancelled_at          when, for the grace-period refund rule
--   cancellation_reason   why
--   check_in_method       how they arrived
--   status 'waitlist'     a legal state the CHECK rejected
--
-- `attended` is deliberately NOT added: the CHECK already has `checked_in`,
-- which means the same thing, and two spellings of one state is how a status
-- column stops being trustworthy. The code says `checked_in` now.
--
-- ── Identity ────────────────────────────────────────────────────────────────
--
-- The module keyed bookings on `bookings.member_id`, an unconstrained TEXT
-- column, filled from `req.user.member_id` — which middleware/rbac.js documents
-- as "always NULL for real client accounts" since migration 154. So the member
-- path could not identify anybody even with a working schema.
--
-- Bookings move to `client_id`, which already exists, already means the right
-- thing, and gets a real foreign key to pt_clients. `clients` — the table it
-- originally referenced — was dropped by migration 170, taking the constraint
-- with it, which is why the column has been sitting unconstrained.
-- ============================================================================


-- ── 1. The columns the module needs and 015 never had ───────────────────────
--
-- Literal ALTER TABLE statements, not a loop: every tenant guard in this repo
-- discovers tables by regex-scanning these files (see 174's note at length).
ALTER TABLE IF EXISTS bookings ADD COLUMN IF NOT EXISTS position            INT;
ALTER TABLE IF EXISTS bookings ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ;
ALTER TABLE IF EXISTS bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE IF EXISTS bookings ADD COLUMN IF NOT EXISTS check_in_method     TEXT;


-- ── 2. Let a booking be on the waitlist ─────────────────────────────────────
--
-- The constraint is found by its columns rather than assumed by name: this
-- table was created by CREATE TABLE IF NOT EXISTS in a migration that has run
-- against differently-shaped databases, and an inline CHECK gets a generated
-- name that is not guaranteed to match across environments.
DO $$
DECLARE c RECORD;
BEGIN
  IF to_regclass('public.bookings') IS NULL THEN RETURN; END IF;

  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public' AND rel.relname = 'bookings'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.bookings DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE '182: dropped status constraint bookings.%', c.conname;
  END LOOP;

  ALTER TABLE public.bookings
    ADD CONSTRAINT bookings_status_check
    CHECK (status IN ('confirmed','waitlist','checked_in','cancelled','no_show'));
END $$;


-- ── 3. Point the booking at a client that exists ────────────────────────────
--
-- Backfill first: `member_id` held whatever the caller passed. Nothing ever
-- inserted successfully, so in practice there is nothing to move — but a
-- database that was hand-seeded, or a future environment, must not lose rows
-- silently, and a value that happens to be a real pt_clients id is exactly what
-- the column was meant to hold.
DO $$
DECLARE moved BIGINT := 0;
BEGIN
  IF to_regclass('public.bookings') IS NULL THEN RETURN; END IF;
  IF to_regclass('public.pt_clients') IS NULL THEN RETURN; END IF;

  UPDATE bookings b
     SET client_id = b.member_id
   WHERE b.client_id IS NULL
     AND b.member_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM pt_clients c WHERE c.id = b.member_id);
  GET DIAGNOSTICS moved = ROW_COUNT;

  IF moved > 0 THEN
    RAISE NOTICE '182: moved % booking(s) from member_id to client_id', moved;
  END IF;
END $$;

-- Then release anything that still does not resolve, so the constraint below
-- can be added without deleting a row to satisfy it. A booking pointing at a
-- client that does not exist is already broken; nulling it makes that visible
-- rather than blocking the migration.
DO $$
DECLARE orphaned BIGINT := 0;
BEGIN
  IF to_regclass('public.bookings') IS NULL OR to_regclass('public.pt_clients') IS NULL THEN RETURN; END IF;

  UPDATE bookings b
     SET client_id = NULL
   WHERE b.client_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pt_clients c WHERE c.id = b.client_id);
  GET DIAGNOSTICS orphaned = ROW_COUNT;

  IF orphaned > 0 THEN
    RAISE WARNING
      '182: released % booking(s) whose client_id matched no pt_clients row. '
      'They are now unattributed and will not appear in anybody''s class history.',
      orphaned;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.bookings') IS NULL OR to_regclass('public.pt_clients') IS NULL THEN RETURN; END IF;

  ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_client_id_fkey;
  ALTER TABLE public.bookings
    ADD CONSTRAINT bookings_client_id_fkey
    FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN
  -- Never wedge the boot over this. The application scopes by client_id either
  -- way; the constraint is the backstop, and an environment that cannot take it
  -- should say so and keep serving.
  RAISE WARNING '182: could not add bookings.client_id foreign key: %', SQLERRM;
END $$;


-- ── 4. Indexes for the two lookups the module actually performs ─────────────
CREATE INDEX IF NOT EXISTS bookings_client_idx  ON bookings (client_id);
CREATE INDEX IF NOT EXISTS bookings_session_idx ON bookings (session_id, status);


-- ── 5. Report ───────────────────────────────────────────────────────────────
DO $$
DECLARE n BIGINT := 0; unattributed BIGINT := 0;
BEGIN
  IF to_regclass('public.bookings') IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO n FROM bookings;
  SELECT count(*) INTO unattributed FROM bookings WHERE client_id IS NULL;
  RAISE NOTICE '182: bookings can now be written — % row(s) present, % unattributed.', n, unattributed;
END $$;
