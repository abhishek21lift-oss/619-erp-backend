-- ============================================================================
-- 175_users_tenant_or_platform.sql
--
-- Every user belongs to a studio, except the platform operator.
--
-- ── Why a CHECK and not NOT NULL ────────────────────────────────────────────
--
-- Migration 155 walked every table with an organization_id and tightened the
-- ones where NULL meant "we forgot". It deliberately left `users` alone, and
-- said why:
--
--     users   the platform super_admin has no organization by design;
--             that is what makes them cross-tenant
--
-- That is still true, and 157 encodes the same fact by putting `users` in its
-- shared_tables list. So NOT NULL is the wrong tool: it would refuse the one
-- account the platform console exists for.
--
-- What is missing is the other half — nothing says a NON-operator must have
-- one. The column is simply nullable, and "nullable" is not a statement about
-- anything.
--
-- ── Why it is worth stating ─────────────────────────────────────────────────
--
-- lib/tenant-db.js is careful about exactly this case. tenantScope() returns
-- applyFilter=true with orgId=null for a tenant user with no organization, so
-- every hand-written filter becomes `organization_id = NULL`, matches nothing,
-- and the request sees an empty screen rather than the platform. Fail-closed,
-- deliberately.
--
-- Six AI tools got that wrong. They branched on `if (org)` — truthy, not
-- applyFilter — which collapses "platform-wide operator" and "tenant user with
-- no org" into the permissive one, and answered revenue_summary, dues_summary,
-- client_stats and trainer_roster PLATFORM-WIDE for such an account. That is
-- fixed in the application, and this constraint removes the state it needed.
--
-- Defence in depth, not the fix. The application fix stands on its own; this
-- makes the precondition unreachable rather than merely unexploited.
--
-- ── NOT VALID, on purpose ───────────────────────────────────────────────────
--
-- A plain ADD CONSTRAINT scans the whole table under an ACCESS EXCLUSIVE lock
-- and fails outright if one legacy row violates it — which on a live database
-- means the migration aborts and takes the deploy with it, for a row that has
-- been sitting there harmlessly for months.
--
-- NOT VALID enforces the rule on every INSERT and UPDATE from this moment on,
-- without scanning what is already there. The scan is then attempted
-- separately below, where it can fail without being fatal. So the rule binds
-- immediately for new data, and old data is reported rather than blocking the
-- release — the same shape as 172, for the same reason.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE NOTICE '175: users does not exist here, skipping';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass
       AND conname = 'users_tenant_or_platform'
  ) THEN
    RAISE NOTICE '175: constraint already present';
  ELSE
    ALTER TABLE public.users
      ADD CONSTRAINT users_tenant_or_platform
      CHECK (role = 'super_admin' OR organization_id IS NOT NULL)
      NOT VALID;
    RAISE NOTICE '175: users_tenant_or_platform added (NOT VALID — enforced for new rows)';
  END IF;
END $$;

-- Now try to prove it for the rows already there.
--
-- Separated from the ADD above so that a pre-existing violation is a WARNING
-- carrying the count, not an aborted deploy. An org-less non-operator account
-- cannot see any studio's data — every filter it produces matches nothing — so
-- the row is already inert; it just cannot log in usefully. Worth fixing, not
-- worth stopping a release for.
DO $$
DECLARE
  bad BIGINT;
BEGIN
  IF to_regclass('public.users') IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO bad
    FROM public.users
   WHERE role <> 'super_admin' AND organization_id IS NULL;

  IF bad = 0 THEN
    ALTER TABLE public.users VALIDATE CONSTRAINT users_tenant_or_platform;
    RAISE NOTICE '175: constraint validated against existing rows';
  ELSE
    RAISE WARNING
      '175: % existing user(s) have no organization and are not super_admin. '
      'The constraint is enforced for new and updated rows but left unvalidated. '
      'Those accounts can authenticate and then see nothing, because every tenant '
      'filter they produce matches no rows. Assign an organization_id (or delete '
      'them) and re-run this migration to validate.', bad;
  END IF;
END $$;
