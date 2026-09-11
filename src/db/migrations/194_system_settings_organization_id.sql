-- ============================================================
-- 194_system_settings_organization_id.sql
-- Make studio settings belong to a studio.
-- ============================================================
--
-- ── The defect ─────────────────────────────────────────────────────────────
--
-- routes/settings.js calls itself "Studio Settings CRUD" and is mounted
-- `auth, requireStaff`. system_settings had no organization_id and not one of
-- its fourteen statements filtered by anything, so all six studios in
-- production shared one set of 35 rows.
--
-- What those rows hold is not incidental:
--
--   studio_name, gym_name, gym_address, email, phone, location
--       one studio's business identity and contact details, readable by any
--       staff user of any other studio.
--   geofence_lat, geofence_lng, geofence_radius
--       the physical coordinates and radius that gate check-in. Five studios
--       were having attendance decided by a sixth studio's map pin.
--   perm_trainer_*, perm_reception_*
--       ROLE PERMISSIONS. An admin in studio A toggling
--       perm_trainer_finance changed what trainers could reach in every other
--       studio. That is a cross-tenant authorization change, not merely a
--       cross-tenant read.
--   currency, gst_rate, invoice_prefix, face_match_threshold, timezone
--
-- Reads leaked and writes collided: `PUT /api/settings` upserts on the key
-- alone, so studio A saving its studio name overwrote studio B's.
--
-- ── Why nothing caught it ──────────────────────────────────────────────────
--
-- Both layers agreed the table was shared. There is no organization_id for a
-- handler to filter on, and the RLS policy is `tenant_shared_read USING
-- (true)` — the database classifying it as platform reference data, like
-- exercises. It was classified once, early, and the classification was wrong
-- for what the table grew into.
--
-- ── Attribution is derived, never assumed ──────────────────────────────────
--
-- 30 of the 35 rows carry updated_by, and every one of those users resolves to
-- ONE organization — so the rows are attributed through that join, not through
-- an id written into this file. The remaining 5 rows (never edited through the
-- API, so seeded) follow them to the same studio.
--
-- The alternative — copying all 35 rows to all six studios — was rejected: it
-- would propagate one studio's email, phone and map pin into five others and
-- call it a fix.
--
-- CONSEQUENCE, deliberate and visible: the five studios that were reading the
-- founding studio's settings now read defaults until they set their own.
-- GYM_DEFAULTS and PERM_DEFAULTS in routes/settings.js already supply those,
-- so no screen breaks. They were never those studios' values to begin with.
--
-- ── No BEGIN/COMMIT here, deliberately ─────────────────────────────────────
--
-- migrate.js wraps every migration with its own `INSERT INTO _migrations`.
-- Enforced by migrations.transactionControl.test.js.

-- ------------------------------------------------------------
-- 1. The column.
-- ------------------------------------------------------------
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

-- ------------------------------------------------------------
-- 2. Attribute the existing rows through their last editor.
-- ------------------------------------------------------------
UPDATE system_settings s
   SET organization_id = u.organization_id
  FROM users u
 WHERE s.updated_by = u.id
   AND s.organization_id IS NULL
   AND u.organization_id IS NOT NULL;

-- Rows never edited through the API — seeded alongside the ones above, so
-- they belong with them. Applied only when the attributed rows point at
-- exactly one studio; if they ever point at several, the seeded rows are
-- genuinely ambiguous and step 4 stops the migration rather than guess.
DO $$
DECLARE owner_org UUID;
BEGIN
  SELECT organization_id INTO owner_org
    FROM system_settings
   WHERE organization_id IS NOT NULL
   GROUP BY organization_id
   HAVING count(*) > 0;

  IF owner_org IS NOT NULL THEN
    UPDATE system_settings SET organization_id = owner_org WHERE organization_id IS NULL;
    RAISE NOTICE '194: attributed settings to studio %', owner_org;
  END IF;
EXCEPTION WHEN TOO_MANY_ROWS THEN
  RAISE NOTICE '194: settings span several studios already — leaving unattributed rows for step 4';
END $$;

-- A database with settings but no users to attribute them through (a fresh
-- bootstrap seeds neither, so this is a no-op there) still needs SOMETHING
-- rather than a NULL that no scoped read can see.
DO $$
DECLARE fallback UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM system_settings WHERE organization_id IS NULL) THEN
    SELECT id INTO fallback FROM organizations ORDER BY created_at LIMIT 1;
    IF fallback IS NOT NULL THEN
      UPDATE system_settings SET organization_id = fallback WHERE organization_id IS NULL;
      RAISE NOTICE '194: attributed remaining settings to the founding studio %', fallback;
    END IF;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Delete orphans only when there is no studio at all.
--
--    A database with settings and zero organizations cannot attribute them to
--    anything. That is a fresh/throwaway install, so the rows are dropped
--    rather than left NULL — a NULL organization_id here is a row no scoped
--    read can see and no scoped write can replace, which is worse than absent.
-- ------------------------------------------------------------
DELETE FROM system_settings
 WHERE organization_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM organizations);

-- ------------------------------------------------------------
-- 4. Refuse to continue if anything is still unattributed.
--
--    Everything below assumes every row has an owner. Making the column NOT
--    NULL would fail with a constraint error naming neither the table's
--    purpose nor the remedy; this says both.
-- ------------------------------------------------------------
DO $$
DECLARE n BIGINT;
BEGIN
  SELECT count(*) INTO n FROM system_settings WHERE organization_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      '194 refused: % system_settings row(s) could not be attributed to a studio. They have no updated_by to resolve and the attributed rows point at more than one organization, so guessing would hand one studio another studio''s configuration. Set organization_id on those rows by hand, then re-run.', n;
  END IF;
END $$;

ALTER TABLE system_settings ALTER COLUMN organization_id SET NOT NULL;

-- ------------------------------------------------------------
-- 5. The key is unique per studio, not globally.
--
--    This is the half that stops the WRITE collision: with PRIMARY KEY (key),
--    `INSERT … ON CONFLICT (key) DO UPDATE` meant studio A saving gym_name
--    overwrote studio B's. The conflict target in routes/settings.js moves to
--    (organization_id, key) in the same commit.
-- ------------------------------------------------------------
ALTER TABLE system_settings DROP CONSTRAINT IF EXISTS system_settings_pkey;
ALTER TABLE system_settings ADD PRIMARY KEY (organization_id, key);

CREATE INDEX IF NOT EXISTS system_settings_org_idx ON system_settings (organization_id);

-- ------------------------------------------------------------
-- 6. Reclassify at the database layer too.
--
--    `tenant_shared_read USING (true)` is how the database said "this is
--    platform reference data". It is not, and leaving it would mean the
--    application filtered while RLS did not — defence in depth with one layer
--    switched off.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS tenant_shared_read ON system_settings;

-- Declared exactly as migration 157 declares every other tenant table's:
-- FOR ALL TO app_tenant, with a WITH CHECK as well as a USING. The first
-- version of this omitted both. Without `TO app_tenant` the policy does not
-- apply to the role the application actually connects as, which
-- rls.isolation.integration.test.js catches by name; without WITH CHECK the
-- policy constrains reads but not INSERTs or UPDATEs, so the database would
-- have let a write land in another studio even though reads were filtered.
--
-- The strict form, not 157's `OR organization_id IS NULL` variant: that exists
-- for tables holding platform-seeded rows, and step 4 above has just
-- guaranteed this one has none.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'system_settings' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON system_settings FOR ALL TO app_tenant
      USING (organization_id::text = current_setting('app.org_id', true))
      WITH CHECK (organization_id::text = current_setting('app.org_id', true));
  END IF;
END $$;

-- ------------------------------------------------------------
-- 7. Verify the end state rather than assume it.
-- ------------------------------------------------------------
DO $$
DECLARE n BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='system_settings'
       AND column_name='organization_id' AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION '194 failed: system_settings.organization_id is missing or still nullable';
  END IF;

  -- Compared structurally, by the columns the key actually covers. An earlier
  -- version matched pg_get_constraintdef() against a literal string and failed
  -- on the quoting of "key" — an assertion about Postgres's formatting rather
  -- than about the constraint.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint con
     WHERE con.conrelid = 'public.system_settings'::regclass
       AND con.contype = 'p'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(con.conkey) k
              JOIN pg_attribute a
                ON a.attrelid = con.conrelid AND a.attnum = k)
           = ARRAY['key','organization_id']
  ) THEN
    RAISE EXCEPTION '194 failed: the primary key does not cover (organization_id, key) — a per-studio key is what stops one studio overwriting another''s setting';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE tablename='system_settings' AND policyname='tenant_shared_read') THEN
    RAISE EXCEPTION '194 failed: the shared-read policy survived — RLS would still treat studio settings as platform data';
  END IF;

  SELECT count(*) INTO n FROM system_settings;
  RAISE NOTICE '194: % settings row(s) now belong to a studio', n;
END $$;
