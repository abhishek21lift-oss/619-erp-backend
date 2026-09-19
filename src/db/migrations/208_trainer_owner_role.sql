-- Canonical studio role model: super_admin (platform), trainer (single studio owner), member (client).
-- Existing studio owner accounts are migrated to trainer. Legacy identifiers remain
-- accepted only at the SQL boundary so older fixtures/in-flight callers are safely
-- canonicalised instead of failing; the trigger immediately stores trainer.

UPDATE users
   SET role = 'trainer', updated_at = NOW()
 WHERE role IN ('admin', 'manager', 'reception', 'receptionist', 'staff');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['super_admin'::text, 'trainer'::text, 'member'::text]));

CREATE OR REPLACE FUNCTION canonicalize_user_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role = 'admin' THEN
    NEW.role := 'trainer';
  ELSIF NEW.role IN ('manager', 'reception', 'receptionist', 'staff') THEN
    NEW.role := 'member';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_canonicalize_role ON users;
CREATE TRIGGER users_canonicalize_role
BEFORE INSERT OR UPDATE OF role ON users
FOR EACH ROW
EXECUTE FUNCTION canonicalize_user_role();
