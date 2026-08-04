-- 148_staff_tables_rls.sql
--
-- `staff` and `staff_targets` are the only two tables in `public` with Row
-- Level Security switched off — the other 168 all have it on with a deny-all
-- policy. This closes that gap.
--
-- On the real exposure, so the next reader does not over- or under-react to the
-- Supabase advisor that flags this: the advisor's wording ("fully exposed to
-- anon and authenticated — anyone with the anon key can read or modify every
-- row") describes a default Supabase project. It does not describe this one.
-- This project revoked the blanket grants: `staff` and `staff_targets` grant
-- nothing at all to anon or authenticated, so PostgREST cannot reach them
-- regardless of RLS. Both tables are also empty. Nothing has leaked.
--
-- It is still worth fixing, for one specific reason. The protection today rests
-- entirely on the absence of a GRANT. Any future `GRANT ... ON ALL TABLES IN
-- SCHEMA public`, or a Supabase-side default-privilege change, would silently
-- make these two readable while the other 168 stayed protected by their
-- policies. RLS is the durable half of that pair; the grant is not.
--
-- Deny-all rather than tenant-scoped policies, matching every other table here
-- (see 130_admin_invitations.sql and 146_studio_registrations.sql). Worth being
-- explicit that this is the deliberate house pattern and not an oversight: the
-- API connects as the table owner, which bypasses RLS entirely, so all tenant
-- isolation is enforced in application SQL via tenantScope(). RLS exists here
-- purely to make the anon/authenticated client keys inert. There is not a
-- single organization_id-scoped policy in the database, and adding one here
-- would be the odd one out, not the fix.
--
-- Safe to apply while the app is running: it cannot lock out the backend, which
-- does not go through these roles.

ALTER TABLE staff         ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_targets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON staff         FROM anon, authenticated;
REVOKE ALL ON staff_targets FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'staff'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON staff
      FOR ALL USING (false) WITH CHECK (false);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'staff_targets'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON staff_targets
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $$;
