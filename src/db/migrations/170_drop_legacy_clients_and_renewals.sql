-- ============================================================
-- 170_drop_legacy_clients_and_renewals.sql
-- Safely remove legacy clients/renewals and their unused views.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Remove the final legacy FK.
-- ------------------------------------------------------------
ALTER TABLE IF EXISTS public.users
    DROP CONSTRAINT IF EXISTS fk_users_member;

-- ------------------------------------------------------------
-- 2. Remove unused legacy views.
--    Verified: no database objects depend on these views.
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.pt_os_active_assignments;
DROP VIEW IF EXISTS public.pt_os_client_health;
DROP VIEW IF EXISTS public.v_active_members;
DROP VIEW IF EXISTS public.v_clients;
DROP VIEW IF EXISTS public.v_expiring_soon;
DROP VIEW IF EXISTS public.v_outstanding_dues;

-- ------------------------------------------------------------
-- 3. Drop legacy tables.
-- ------------------------------------------------------------
DROP TABLE IF EXISTS public.renewals;
DROP TABLE IF EXISTS public.clients;

-- ------------------------------------------------------------
-- 4. Remove legacy sequences if present.
-- ------------------------------------------------------------
DROP SEQUENCE IF EXISTS public.clients_id_seq;
DROP SEQUENCE IF EXISTS public.renewals_id_seq;

-- ------------------------------------------------------------
-- 5. Final verification.
-- ------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('public.clients') IS NOT NULL THEN
        RAISE EXCEPTION
            'Migration 170 failed: public.clients still exists';
    END IF;

    IF to_regclass('public.renewals') IS NOT NULL THEN
        RAISE EXCEPTION
            'Migration 170 failed: public.renewals still exists';
    END IF;

    IF to_regclass('public.v_clients') IS NOT NULL
       OR to_regclass('public.v_active_members') IS NOT NULL
       OR to_regclass('public.v_expiring_soon') IS NOT NULL
       OR to_regclass('public.v_outstanding_dues') IS NOT NULL
       OR to_regclass('public.pt_os_active_assignments') IS NOT NULL
       OR to_regclass('public.pt_os_client_health') IS NOT NULL THEN
        RAISE EXCEPTION
            'Migration 170 failed: one or more legacy views still exist';
    END IF;

    RAISE NOTICE
        'Migration 170: legacy clients, renewals and unused legacy views successfully removed';
END $$;

COMMIT;
