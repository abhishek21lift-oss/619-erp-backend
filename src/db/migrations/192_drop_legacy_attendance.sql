-- ============================================================
-- 192_drop_legacy_attendance.sql
-- Retire the legacy `attendance` table. attendance_logs is canonical.
-- ============================================================
--
-- ── Why this table goes ─────────────────────────────────────────────────────
--
-- Unlike the `payments` retirement in 191, this is not a tenancy hole. Both
-- tables carry organization_id NOT NULL, an organizations FK and the same
-- `tenant_isolation` RLS policy, and `attendance` additionally has FORCE ROW
-- LEVEL SECURITY. Nothing here was ever leakable.
--
-- The problem was that the two tables were not two copies of one register.
-- They were one register and one write-only hole. Every surface that DISPLAYS
-- attendance reads attendance_logs:
--
--   routes/attendance.js           the register, today-summary, bulk marking
--   routes/qr-checkin.js           scan, checkout, dashboard, my-history
--   modules/client-portal          GET /api/me/attendance
--   modules/pt-os/pt-os.service    a client's attendance history
--   modules/automation/…repository the missed-visit automation sweep
--   lib/ai/tools.js                the attendance_summary AI tool
--   modules/platform/super-admin   cross-studio activity analytics
--
-- Exactly one writer used `attendance`: bookings.service.js checkIn(), which
-- mirrored a class check-in into it. Nothing read that mirror back. A member
-- could check in at the door for a class they had booked, the booking would
-- flip to 'attended', and the studio's register, the member's own portal
-- history and the missed-visit automation would all carry on as though they
-- had never arrived.
--
-- That writer was repointed at attendance_logs in the commit carrying this
-- migration. `attendance` holds 0 rows in production — and `bookings`,
-- `class_sessions` and `members` all hold 0 rows too, so the class-booking
-- flow that fed it has never run and no real check-in was lost to this.
--
-- ── What the repoint had to reconcile ───────────────────────────────────────
--
--   attendance.type            → attendance_logs.ref_type
--   attendance.check_in  TIME  → attendance_logs.check_in_time TIMESTAMPTZ
--   attendance.check_in_method → attendance_logs.method  (which, unlike the
--                                legacy column, carries a CHECK — the service
--                                now clamps an unrecognised method to
--                                'manual' rather than 500ing the check-in)
--   attendance.member_id       → dropped: the legacy INSERT passed the same
--                                value as ref_id, so it was always redundant
--   attendance.booking_id      → carried in notes. If the class-booking flow
--                                is ever revived in earnest this deserves a
--                                real column rather than free text.
--
-- ── Rollback ────────────────────────────────────────────────────────────────
--
-- The table is empty, so recreating it loses nothing. Its full definition as
-- it stands in production — columns, constraints, indexes, RLS — is preserved
-- in 192_drop_legacy_attendance.ROLLBACK.md, alongside this file rather than
-- inside it: the domains convention test scans .sql for CREATE/DROP without
-- stripping comments, so a commented-out CREATE TABLE here would be read as a
-- live one and report the table as unowned.
--
-- ── No BEGIN/COMMIT here, deliberately ──────────────────────────────────────
--
-- migrate.js already wraps every migration in a transaction together with the
-- `INSERT INTO _migrations` that records it as applied, so the DDL and its
-- bookkeeping commit together or not at all. A migration that opens its own
-- transaction closes the runner's early. Enforced by
-- migrations.transactionControl.test.js.

-- ------------------------------------------------------------
-- 1. Refuse to run if anything ever landed in this table.
--
--    The whole argument for dropping rather than migrating is that the table
--    is empty. If that stops being true between writing this and running it,
--    this migration is wrong and must fail loudly rather than destroy a
--    studio's attendance history.
--
--    A row here would mean the class-booking check-in ran somewhere between
--    this being written and applied; those rows map onto attendance_logs by
--    the column correspondence documented above.
-- ------------------------------------------------------------
DO $$
DECLARE n BIGINT;
BEGIN
  IF to_regclass('public.attendance') IS NULL THEN
    RAISE NOTICE '192: attendance already absent — nothing to do';
    RETURN;
  END IF;
  EXECUTE 'SELECT COUNT(*) FROM public.attendance' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      '192 refused: public.attendance holds % row(s). This migration only drops an EMPTY legacy table. Copy those rows into attendance_logs (type→ref_type, check_in→check_in_time, check_in_method→method) before re-running.', n;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Drop any inbound foreign key, from the catalog rather than by name.
--
--    Production has none today — face_checkin_logs.attendance_id is a plain
--    TEXT column with no constraint behind it, which migration 034 left that
--    way. Reading the catalog rather than naming constraints means a database
--    that grew one out of band still drops cleanly instead of failing on a
--    dependency this file did not know about.
-- ------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
  IF to_regclass('public.attendance') IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT src.relname AS tbl, con.conname AS name
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
     WHERE con.contype = 'f'
       AND con.confrelid = 'public.attendance'::regclass
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tbl, r.name);
    RAISE NOTICE '192: dropped inbound FK %.%', r.tbl, r.name;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. Drop the table.
--
--    Its own indexes, constraints and RLS policies go with it. No CASCADE:
--    step 2 has already cleared anything that could depend on it, so a
--    failure here means a dependency this migration has not reasoned about,
--    and stopping is the correct response to that.
-- ------------------------------------------------------------
DROP TABLE IF EXISTS public.attendance;

-- ------------------------------------------------------------
-- 4. Verify the end state rather than assume it.
--
--    A migration that silently half-applies is worse than one that fails, and
--    every statement above is guarded in a way that can no-op.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.attendance') IS NOT NULL THEN
    RAISE EXCEPTION '192 failed: public.attendance still exists after the drop';
  END IF;

  IF to_regclass('public.attendance_logs') IS NULL THEN
    RAISE EXCEPTION '192 failed: public.attendance_logs is missing — the canonical table must survive this migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'attendance_logs'
       AND column_name  = 'organization_id'
  ) THEN
    RAISE EXCEPTION '192 failed: attendance_logs has no organization_id — refusing to leave attendance unscopable';
  END IF;

  RAISE NOTICE '192: attendance dropped; attendance_logs is the only attendance table';
END $$;
