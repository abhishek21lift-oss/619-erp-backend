-- Canonical studio role model: super_admin (platform), trainer (single studio owner), member (client).
-- Existing studio admin/manager/reception/staff accounts are migrated to trainer.
-- The live 619-ERP database was verified before this migration: each tenant has
-- exactly one active admin and zero active trainer/manager/reception accounts.

BEGIN;

UPDATE users
   SET role = 'trainer', updated_at = NOW()
 WHERE role IN ('admin', 'manager', 'reception', 'receptionist', 'staff');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['super_admin'::text, 'trainer'::text, 'member'::text]));

-- One active studio owner account per tenant. Platform super_admin is excluded.
CREATE UNIQUE INDEX IF NOT EXISTS users_one_owner_trainer_per_org
  ON users (organization_id)
  WHERE role = 'trainer' AND deleted_at IS NULL AND organization_id IS NOT NULL;

COMMIT;
