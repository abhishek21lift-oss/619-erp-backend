-- 208_trainer_owner_role.sql
-- Canonical studio model:
--   super_admin = platform operator
--   trainer     = studio staff identity (the owner is a trainer too)
--   member      = client
--
-- IMPORTANT: role != ownership. A studio may have many trainers, but exactly
-- one owner. The former admin account becomes trainer + is_owner=true.
-- Existing manager/reception/staff accounts become trainer + is_owner=false
-- so their work identity is preserved without keeping retired role identifiers.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE;

-- Former admin is the owner. If bad legacy data contains multiple admins in one
-- studio, keep one deterministic owner and preserve the others as trainers.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY organization_id
           ORDER BY is_active DESC, updated_at DESC NULLS LAST, id
         ) AS rn
    FROM users
   WHERE role = 'admin'
     AND organization_id IS NOT NULL
)
UPDATE users u
   SET role = 'trainer',
       is_owner = (r.rn = 1),
       updated_at = NOW()
  FROM ranked r
 WHERE u.id = r.id;

-- Retired staff role identifiers are no longer canonical, but their accounts
-- remain trainer staff rather than becoming client/member accounts.
UPDATE users
   SET role = 'trainer',
       is_owner = FALSE,
       updated_at = NOW()
 WHERE role IN ('manager', 'reception', 'receptionist', 'staff');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['super_admin'::text, 'trainer'::text, 'member'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS users_one_owner_per_org
  ON users (organization_id)
  WHERE is_owner = TRUE
    AND role = 'trainer'
    AND organization_id IS NOT NULL;

CREATE OR REPLACE FUNCTION canonicalize_user_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role = 'admin' THEN
    NEW.role := 'trainer';
    NEW.is_owner := TRUE;
  ELSIF NEW.role IN ('manager', 'reception', 'receptionist', 'staff') THEN
    NEW.role := 'trainer';
    NEW.is_owner := FALSE;
  ELSIF NEW.role <> 'trainer' THEN
    NEW.is_owner := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_canonicalize_role ON users;
CREATE TRIGGER users_canonicalize_role
BEFORE INSERT OR UPDATE OF role, is_owner ON users
FOR EACH ROW
EXECUTE FUNCTION canonicalize_user_role();
