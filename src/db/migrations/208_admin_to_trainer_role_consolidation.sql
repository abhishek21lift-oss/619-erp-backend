-- Migration: 208_admin_to_trainer_role_consolidation.sql
-- Consolidates legacy roles (admin, manager, reception, staff) → trainer
-- Enforces 1 Studio = 1 Trainer model
-- Created: 2026-09-19

BEGIN;

-- 1. Backup existing role assignments before migration
CREATE TABLE IF NOT EXISTS _backup_admin_rename AS
SELECT id, organization_id, email, name, role, created_at, updated_at
FROM users
WHERE role IN ('admin', 'manager', 'reception', 'receptionist', 'staff')
AND deleted_at IS NULL;

-- 2. Migrate all legacy tenant roles to 'trainer'
UPDATE users SET role = 'trainer'
WHERE role IN ('admin', 'manager', 'reception', 'receptionist', 'staff')
AND role != 'super_admin';

-- 3. Enforce strict 3-role constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['super_admin'::text, 'trainer'::text, 'member'::text]));

-- 4. Invalidate existing sessions for migrated users
UPDATE users SET token_version = COALESCE(token_version, 0) + 1
WHERE role = 'trainer';

-- 5. Enforce 1 Studio = 1 Trainer unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_trainer_per_org
ON users (organization_id)
WHERE role = 'trainer' AND deleted_at IS NULL;

-- 6. Update RLS policies that referenced legacy roles
-- gym_settings: trainer replaces admin
DROP POLICY IF EXISTS "gym_settings_staff_can_read" ON gym_settings;
CREATE POLICY "gym_settings_staff_can_read" ON gym_settings
FOR SELECT USING (EXISTS (
  SELECT 1 FROM users
  WHERE users.organization_id = gym_settings.organization_id
  AND users.role IN ('super_admin', 'trainer')
  AND users.deleted_at IS NULL
));

DROP POLICY IF EXISTS "gym_settings_staff_can_update" ON gym_settings;
CREATE POLICY "gym_settings_staff_can_update" ON gym_settings
FOR UPDATE USING (EXISTS (
  SELECT 1 FROM users
  WHERE users.organization_id = gym_settings.organization_id
  AND users.role IN ('super_admin', 'trainer')
  AND users.deleted_at IS NULL
));

-- webauthn_credentials: trainer replaces admin/manager
DROP POLICY IF EXISTS "webauthn_credentials_staff_read" ON webauthn_credentials;
CREATE POLICY "webauthn_credentials_staff_read" ON webauthn_credentials
FOR SELECT USING (EXISTS (
  SELECT 1 FROM users u
  JOIN webauthn_credentials wc ON wc.user_id = u.id
  WHERE u.role IN ('super_admin', 'trainer')
  AND u.deleted_at IS NULL
));

DROP POLICY IF EXISTS "webauthn_credentials_staff_manage" ON webauthn_credentials;
CREATE POLICY "webauthn_credentials_staff_manage" ON webauthn_credentials
FOR ALL USING (EXISTS (
  SELECT 1 FROM users u
  JOIN webauthn_credentials wc ON wc.user_id = u.id
  WHERE u.role IN ('super_admin', 'trainer')
  AND u.deleted_at IS NULL
));

-- webauthn_challenges: trainer replaces admin
DROP POLICY IF EXISTS "webauthn_challenges_staff_read" ON webauthn_challenges;
CREATE POLICY "webauthn_challenges_staff_read" ON webauthn_challenges
FOR SELECT USING (EXISTS (
  SELECT 1 FROM users u
  JOIN webauthn_challenges wch ON wch.user_id = u.id
  WHERE u.role IN ('super_admin', 'trainer')
  AND u.deleted_at IS NULL
));

-- biometric_attendance: trainer replaces admin/manager
DROP POLICY IF EXISTS "biometric_attendance_staff_read" ON biometric_attendance;
CREATE POLICY "biometric_attendance_staff_read" ON biometric_attendance
FOR SELECT USING (EXISTS (
  SELECT 1 FROM users u
  JOIN biometric_attendance ba ON ba.user_id = u.id
  WHERE u.role IN ('super_admin', 'trainer')
  AND u.deleted_at IS NULL
));

DROP POLICY IF EXISTS "biometric_attendance_staff_manage" ON biometric_attendance;
CREATE POLICY "biometric_attendance_staff_manage" ON biometric_attendance
FOR ALL USING (EXISTS (
  SELECT 1 FROM users u
  JOIN biometric_attendance ba ON ba.user_id = u.id
  WHERE u.role IN ('super_admin', 'trainer')
  AND u.deleted_at IS NULL
));

COMMIT;