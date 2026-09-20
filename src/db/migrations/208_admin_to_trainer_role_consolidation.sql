-- Migration: 208_admin_to_trainer_role_consolidation.sql
-- Description: Consolidate studio roles (admin, manager, reception, staff) into trainer (1 Studio = 1 Trainer owner model).
--              super_admin and multi-tenant isolation remain completely untouched.

BEGIN;

-- 1. Create backup table to record previous role assignments for audit and rollback safety
CREATE TABLE IF NOT EXISTS _backup_admin_rename (
  id TEXT NOT NULL,
  old_role TEXT NOT NULL,
  organization_id TEXT,
  renamed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Populate backup table
INSERT INTO _backup_admin_rename (id, old_role, organization_id, renamed_at)
SELECT id, role, organization_id, NOW()
FROM users
WHERE role IN ('admin', 'manager', 'reception', 'receptionist', 'staff');

-- 3. Cutover legacy roles to 'trainer' and bump token_version to invalidate stale JWTs
UPDATE users
SET role = 'trainer',
    token_version = COALESCE(token_version, 0) + 1,
    updated_at = NOW()
WHERE role IN ('admin', 'manager', 'reception', 'receptionist', 'staff');

-- 4. Update the role CHECK constraint on the users table
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role = ANY (ARRAY['super_admin', 'trainer', 'member']));

-- 5. Update RLS policies referencing legacy 'admin' to 'trainer'
-- (Applies only if policies exist on these tables)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'gym_settings' AND policyname = 'gym_settings_admin_full'
  ) THEN
    DROP POLICY IF EXISTS gym_settings_admin_full ON gym_settings;
    CREATE POLICY gym_settings_trainer_full ON gym_settings
      FOR ALL
      TO app_tenant
      USING (
        current_setting('app.org_id', true) = organization_id::text
        AND current_setting('app.role', true) IN ('trainer', 'super_admin')
      )
      WITH CHECK (
        current_setting('app.org_id', true) = organization_id::text
        AND current_setting('app.role', true) IN ('trainer', 'super_admin')
      );
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'webauthn_credentials' AND policyname = 'webauthn_credentials_admin'
  ) THEN
    DROP POLICY IF EXISTS webauthn_credentials_admin ON webauthn_credentials;
    CREATE POLICY webauthn_credentials_trainer ON webauthn_credentials
      FOR ALL
      TO app_tenant
      USING (
        current_setting('app.org_id', true) = organization_id::text
        AND current_setting('app.role', true) IN ('trainer', 'super_admin')
      );
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'biometric_attendance' AND policyname = 'biometric_attendance_admin'
  ) THEN
    DROP POLICY IF EXISTS biometric_attendance_admin ON biometric_attendance;
    CREATE POLICY biometric_attendance_trainer ON biometric_attendance
      FOR ALL
      TO app_tenant
      USING (
        current_setting('app.org_id', true) = organization_id::text
        AND current_setting('app.role', true) IN ('trainer', 'super_admin')
      );
  END IF;
END $$;

-- 6. Enforce 1 Studio = 1 Trainer model at the database level (per active tenant)
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_trainer_per_org
ON users (organization_id)
WHERE role = 'trainer' AND deleted_at IS NULL AND organization_id IS NOT NULL;

COMMIT;
