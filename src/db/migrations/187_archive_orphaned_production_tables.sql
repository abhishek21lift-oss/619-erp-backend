-- ============================================================
-- 187_archive_orphaned_production_tables.sql
--
-- ── What this is ────────────────────────────────────────────
--
-- The target-architecture audit's R1b finding: 28 tables exist in
-- production that no migration in this repo, and no schema.sql, ever
-- creates. src/architecture/domains.js (the domain manifest) assigns
-- an owner to every table the repo's own migration history produces
-- (enforced by architecture.domains.convention.test.js) — these 28
-- are outside that history entirely, so they can have no owner, no
-- decided tenancy model, and no RLS shape anyone signed off on. Twenty-
-- six were found in the original audit; `staff` and `staff_targets`
-- turned up during PR #106, once the manifest's schema scanner was
-- fixed to track DROP/RENAME as well as CREATE (see that test file's
-- header) and treated as the same class of problem rather than a
-- separate migration.
--
-- Confirmed dead, not merely unowned, before writing this:
--   - Fresh row counts taken directly from production immediately
--     before this migration was written (see below).
--   - No route, service, or model anywhere in src/ issues SQL naming
--     any of the 28 — checked with the same FROM/JOIN/INTO/UPDATE
--     scan orphanTables.convention.test.js uses to catch the opposite
--     drift (code referencing a table the schema doesn't have).
--   - For `staff`/`staff_targets` specifically: migration 064 already
--     dropped both years ago. Production's `_migrations` table records
--     a file named `staff.sql` — not present anywhere in this repo's
--     history — having run at some point after 064, which is what put
--     both tables back. That file is gone; nothing in the current
--     migration set can ever replay it.
--
-- Row counts at the time this migration was written (2026-09-08):
--   settings=12, gym_settings=1, gyms=1 — every other table below: 0.
--
-- ── Why archive, not drop ───────────────────────────────────
--
-- The three non-empty tables predate multi-tenancy:
--   settings        12 key/value rows (gym_name, gst, currency, …) —
--                   fully superseded by `system_settings`, which is
--                   what routes/settings.js actually reads and writes.
--   gym_settings    1 row of check-in geofence config, column-for-
--                   column the same fields `system_settings` now
--                   stores under the GYM_KEYS prefix (see
--                   routes/settings.js GET/PUT /api/settings/gym).
--   gyms            1 row — the single pre-multi-tenant studio record,
--                   superseded by `organizations` (6 real tenants
--                   today, none of them this row).
--
-- None of that is disposable-because-worthless; it is
-- disposable-because-already-migrated-elsewhere, and the brief's rule
-- is explicit: no destructive schema change without a backup/rollback
-- path. DROP is a one-way door — recovering from it means a
-- point-in-time restore of the whole database. Moving every table
-- listed below into a new `archived` schema keeps every row, intact,
-- reachable by any future audit or a real backfill, while removing it
-- from `public` — which is what actually matters for the manifest,
-- for a fresh install (this migration is a no-op there; to_regclass
-- guards every branch), and for anyone reading `\dt public.*` and
-- trying to tell live architecture from debris. Undoing this is one
-- statement per table (`ALTER TABLE archived.x SET SCHEMA public`),
-- not a restore.
--
-- A permanent DROP of the archived copies, if ever wanted, is a
-- separate, later, deliberately-boring migration once nobody has had
-- a reason to reach into `archived` for a bake period — not a decision
-- this migration makes.
--
-- ── Defense in depth ────────────────────────────────────────
--
-- `archived` gets no GRANT USAGE to app_tenant, anon, or authenticated,
-- so none of them can resolve archived.<table> even schema-qualified.
-- The explicit REVOKE below is belt-and-suspenders on top of that for
-- app_tenant specifically, since 157_app_tenant_role_and_rls.sql grants
-- app_tenant blanket DML on "ALL TABLES IN SCHEMA public" and that
-- grant is a relation-level ACL that a schema move alone does not
-- clear.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'archived') THEN
    CREATE SCHEMA archived;
  END IF;
END $$;

COMMENT ON SCHEMA archived IS
  'Tables retired from public by migration 187+ because no owning domain, no migration history, and no live code path claim them. Data is preserved, not deleted — see 187_archive_orphaned_production_tables.sql for the full rationale per table.';

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'class_schedules', 'client_documents', 'client_notifications',
    'client_referrals', 'enquiries', 'follow_ups', 'gym_settings', 'gyms',
    'incentives', 'kiosk_devices', 'member_actions', 'membership_plans',
    'memberships', 'plan_metrics', 'pt_os_ai_insights', 'pt_os_assignments',
    'pt_os_automation_rules', 'pt_os_coaching_events', 'pt_os_earnings',
    'pt_os_incentive_rules', 'pt_os_packages', 'pt_os_payments',
    'pt_os_sessions', 'referrals', 'settings', 'staff', 'staff_targets',
    'workouts'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM app_tenant', t);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
      END IF;
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA archived', t);
      RAISE NOTICE '187: archived public.% -> archived.%', t, t;
    ELSE
      RAISE NOTICE '187: public.% does not exist, nothing to archive (expected on a fresh install)', t;
    END IF;
  END LOOP;
END $$;

-- ── Verification ─────────────────────────────────────────────
-- Fails the migration loudly if any of the 28 names still resolve in
-- `public` afterward, rather than deploying silently half-done.
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'class_schedules', 'client_documents', 'client_notifications',
    'client_referrals', 'enquiries', 'follow_ups', 'gym_settings', 'gyms',
    'incentives', 'kiosk_devices', 'member_actions', 'membership_plans',
    'memberships', 'plan_metrics', 'pt_os_ai_insights', 'pt_os_assignments',
    'pt_os_automation_rules', 'pt_os_coaching_events', 'pt_os_earnings',
    'pt_os_incentive_rules', 'pt_os_packages', 'pt_os_payments',
    'pt_os_sessions', 'referrals', 'settings', 'staff', 'staff_targets',
    'workouts'
  ];
  leftover TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      leftover := array_append(leftover, t);
    END IF;
  END LOOP;
  IF array_length(leftover, 1) > 0 THEN
    RAISE EXCEPTION '187: still present in public after archive: %', array_to_string(leftover, ', ');
  END IF;
END $$;
