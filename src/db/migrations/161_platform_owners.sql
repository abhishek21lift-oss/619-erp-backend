-- 161_platform_owners.sql
-- An explicit grant for cross-tenant power.
--
-- Until now, "may act across every studio" was a string in a column:
-- users.role = 'super_admin'. Everything that separates the platform control
-- plane from the tenant application — requireSuperAdmin, the platform-wide
-- branch of tenantScope(), and the owner database connection that bypasses RLS
-- entirely — hangs off that one comparison.
--
-- The problem is not that the check is wrong. It is that the check is the only
-- thing there, so the blast radius of any write that reaches users.role is the
-- whole platform. A tenant-admin screen that lets an owner edit a staff row, a
-- seed script, a support fix applied with psql at 2am, a future bug in an
-- update handler that forgets to exclude `role` from the patch body — each is
-- one UPDATE away from handing a studio every other studio's data. There is no
-- second thing to also be true, and no record that anybody intended it.
--
-- This table is that second thing. Membership is separate from the role, lives
-- on a table no tenant-facing code path writes, and carries who granted it and
-- when, so the grant is auditable rather than inferred.
--
-- ── Seeded from today's super admins, deliberately ──────────────────────────
--
-- Every existing role='super_admin' account is inserted below. That is what
-- makes this migration inert on the way in: the moment it lands, the new check
-- (role = 'super_admin' AND a row here) answers exactly what the old check
-- (role = 'super_admin') answered for every account that exists. Nothing gains
-- access, nobody loses it, and the platform operator does not get locked out of
-- their own console by a deploy. The grant only starts to bite the NEXT time
-- somebody's role changes without an accompanying, deliberate grant here.
--
-- ── Why not just drop the role check and use this table alone ───────────────
--
-- Because the two checks fail in different directions, and keeping both means
-- an attacker needs both. The role is what the session and the UI already
-- reason about; this table is what the security boundary reasons about. A row
-- here with no matching role is not enough, and a role with no row here is not
-- enough. See middleware/platformAuth.js, which requires both.

CREATE TABLE IF NOT EXISTS platform_owners (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Free text, for the human reason. Nothing parses it; it exists so that a
  -- row found here in six months can be explained without archaeology.
  note         TEXT,
  -- Soft revocation. A revoked grant keeps its history rather than vanishing,
  -- which is the difference between "this person never had access" and "this
  -- person's access was taken away on the 3rd". The authorization check reads
  -- revoked_at IS NULL.
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_platform_owners_active
  ON platform_owners (user_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE platform_owners IS
  'Explicit grant of cross-tenant platform authority. Required IN ADDITION to '
  'users.role = ''super_admin'' by middleware/platformAuth.js. No tenant-facing '
  'code path writes this table.';

-- Seed: every current super admin keeps the access they have today.
-- granted_by is NULL and the note says so, which is how these are told apart
-- from grants a human actually made.
INSERT INTO platform_owners (user_id, granted_by, note)
SELECT u.id, NULL, 'Seeded by migration 161 from existing role=super_admin'
  FROM users u
 WHERE u.role = 'super_admin'
   AND u.deleted_at IS NULL
ON CONFLICT (user_id) DO NOTHING;

-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- Same shape as every other table under 157/159: the app_tenant role must
-- never see this table at all. It has no organization_id and never will — a
-- platform owner belongs to no studio — so there is no tenant-scoping policy
-- to write. The absence of any policy FOR app_tenant is the policy: with RLS
-- enabled and no matching policy, app_tenant reads zero rows and writes none.
--
-- The platform console reaches it over the owner connection (ADMIN_DATABASE_URL),
-- which is not subject to RLS. That is the same route every other cross-tenant
-- read already takes, and it is why this needs no grant to app_tenant.
ALTER TABLE platform_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_owners FORCE ROW LEVEL SECURITY;

-- Deny-all for the PostgREST roles, matching the convention the existing 247
-- policies follow (see TENANT-RLS-PLAN.md): a leaked publishable key must not
-- reach this table either.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.platform_owners FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.platform_owners FROM authenticated';
  END IF;
  -- app_tenant may not even be told the table is there. Created by 157; guard
  -- the REVOKE so this migration still runs on a database where 157 has not.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE 'REVOKE ALL ON public.platform_owners FROM app_tenant';
  END IF;
END $$;
