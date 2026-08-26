-- ============================================================================
-- 180_settings_tenant_scope.sql
--
-- `system_settings` and `feature_flags` are the last two tables that hold
-- per-studio configuration and have no tenant column.
--
-- ── What that meant ─────────────────────────────────────────────────────────
--
-- routes/settings.js is the only consumer of either table, and every one of
-- its fourteen queries addressed the whole platform:
--
--   GET  /api/settings              every studio's keys
--   GET  /api/settings/studio       every studio's keys AND branches
--   GET  /api/settings/branches     every studio's branches
--   GET  /api/settings/gym          whichever studio wrote last
--   GET  /api/settings/permissions  whichever studio wrote last
--   GET  /api/settings/feature-flags   one row per flag, platform-wide
--   PUT  /api/settings              arbitrary key/value, platform-wide
--   PUT  /api/settings/gym          gym name, address, GST, geofence
--   PUT  /api/settings/permissions  the sixteen-key role matrix
--   PUT  /api/settings/feature-flags
--   POST/PUT/DELETE /api/settings/branches/:id
--
-- The write routes are gated on `adminOnly` — role 'admin', which is the
-- ordinary Studio Owner role auto-granted to every self-serve trial signup,
-- NOT the platform operator. So any trial account could overwrite every
-- studio's gym identity, delete a competitor's branch, or flip a feature flag
-- for the entire platform. There was no filter to forget: the column did not
-- exist, so no filter was possible.
--
-- tenantColumns.convention.test.js carried both tables in KNOWN_GAPS with the
-- note "per-studio keys (branch_N) inside a shared table". That rationale
-- holds for `branch_%` keys, which are at least namespaced per row. It does
-- not hold for GYM_KEYS, PERM_KEYS or feature_flags, which are fixed global
-- names with exactly one row each for the whole platform.
--
-- ── Reading order ───────────────────────────────────────────────────────────
--   1. add the columns
--   2. attribute branch rows from the clients that reference them
--   3. replace the globally-unique primary keys with per-studio unique indexes
--   4. fan the remaining platform-global rows out, one copy per studio
--   5. index and enable RLS
--   6. report what could not be attributed
--
-- Step 3 must precede step 4. While PRIMARY KEY (key) still stands, a second
-- row carrying the same key conflicts on it, and the fan-out's
-- ON CONFLICT DO NOTHING would skip every single insert — leaving the tables
-- scoped, empty per studio, and every studio's configuration gone.
--
-- ── What this migration deliberately does NOT do ────────────────────────────
--
-- It does not DELETE the original organization_id IS NULL rows after fanning
-- them out. They become unreachable — every query in routes/settings.js now
-- carries an organization_id predicate, and the strict RLS policy in step 5
-- does not admit NULL — so leaving them costs a few dead rows and buys a
-- migration that destroys nothing. A security fix is the worst possible place
-- to combine a scoping change with an irreversible delete.
--
-- It does not set the columns NOT NULL. Unattributable `branch_%` rows (step 6)
-- must be allowed to remain, and they are invisible to every studio, which for
-- a branch no client references is the correct outcome.
-- ============================================================================


-- ── 1. Columns ──────────────────────────────────────────────────────────────
--
-- Literal ALTER TABLE statements, never a dynamic EXECUTE loop, for the reason
-- migration 174 spells out at length: tenantScope.convention.test.js,
-- tenantColumns.convention.test.js and 157's policy generator all discover
-- which tables are tenant tables by REGEX-SCANNING THESE FILES. A column added
-- through format()/EXECUTE exists in the database and is invisible to all
-- three, which is the original bug reintroduced by the fix for it.
--
-- ON DELETE CASCADE, deviating from the ON DELETE SET NULL used by the 25
-- other retrofits in these migrations, and the deviation is the point: SET NULL
-- would turn a deleted studio's rows back into exactly the platform-global rows
-- this migration exists to eliminate — its gym name and permission matrix
-- would silently become a shared default again. Configuration is worthless
-- without the studio it configures, so it goes with the studio.
ALTER TABLE IF EXISTS system_settings ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE IF EXISTS feature_flags   ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;


-- ── 2. Attribute branch rows from the clients that reference them ───────────
--
-- A branch lives as a single `branch_<uuid>` row whose value is a JSON blob.
-- Its only link to a studio is that `pt_clients.branch_id` holds the full
-- system_settings key (see the member_count subquery in routes/settings.js).
-- pt_clients.organization_id has been NOT NULL since migration 155, so every
-- branch a client actually uses is attributable.
--
-- Only rows resolving to exactly ONE organisation are attributed. A branch key
-- referenced by clients in two studios is pre-existing corruption, and guessing
-- which studio owns it would hand one studio's branch to another — reported in
-- step 6 instead.
DO $$
DECLARE
  attributed BIGINT;
BEGIN
  IF to_regclass('public.system_settings') IS NULL THEN RETURN; END IF;
  IF to_regclass('public.pt_clients') IS NULL THEN
    RAISE NOTICE '180: pt_clients absent — skipping branch attribution';
    RETURN;
  END IF;

  UPDATE system_settings s
     SET organization_id = a.org_id
    FROM (
      -- (array_agg(DISTINCT …))[1] rather than min(), because Postgres has no
      -- min(uuid) aggregate — `function min(uuid) does not exist` aborts the
      -- migration. The HAVING below already guarantees exactly one distinct
      -- value, so taking the first element is not a choice between candidates.
      SELECT c.branch_id AS branch_key,
             (array_agg(DISTINCT c.organization_id))[1] AS org_id
        FROM pt_clients c
       WHERE c.branch_id IS NOT NULL
         AND c.organization_id IS NOT NULL
         AND c.deleted_at IS NULL
       GROUP BY c.branch_id
      HAVING count(DISTINCT c.organization_id) = 1
    ) a
   WHERE s.key = a.branch_key
     AND s.key LIKE 'branch\_%'
     AND s.organization_id IS NULL;

  GET DIAGNOSTICS attributed = ROW_COUNT;
  RAISE NOTICE '180: attributed % branch row(s) from pt_clients', attributed;
END $$;




-- ── 3. Replace the globally-unique primary keys ─────────────────────────────
--
-- Both tables are PRIMARY KEY (key), which is the same shape migration 174
-- found on `integrations`: the key IS the thing, so exactly one studio on the
-- platform can own each one. `gym_name` is a single row; the second studio to
-- set it overwrites the first.
--
-- Replaced with a unique INDEX on (organization_id, key) rather than a new
-- composite PRIMARY KEY, following 174's reasoning for integrations: a PRIMARY
-- KEY requires NOT NULL, and step 6 cannot promise every legacy branch row is
-- attributable. A unique index accepts the leftovers, and routes/settings.js
-- targets it with ON CONFLICT (organization_id, key).
--
-- Note NULLs are distinct in a Postgres unique index, so the pre-migration
-- rows left behind by step 2 do not collide with each other. They are
-- unreachable rather than constrained — see the header.
--
-- Constraint names are resolved from pg_catalog rather than assumed: both
-- tables were created by CREATE TABLE IF NOT EXISTS in migrations that ran at
-- different times against differently-shaped databases.
DO $$
DECLARE
  t TEXT;
  c RECORD;
BEGIN
  FOREACH t IN ARRAY ARRAY['system_settings', 'feature_flags']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;

    FOR c IN
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname = 'public' AND rel.relname = t
         AND con.contype IN ('p', 'u')
         AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
                FROM unnest(con.conkey) k
                JOIN pg_attribute att
                  ON att.attrelid = con.conrelid AND att.attnum = k) = ARRAY['key']
    LOOP
      -- CASCADE, because a foreign key elsewhere could depend on the PK.
      -- Nothing in this schema references either table by key, so this drops
      -- the constraint and nothing else; CASCADE only removes the need to
      -- discover that fact at deploy time.
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I CASCADE', t, c.conname);
      RAISE NOTICE '180: dropped platform-wide key constraint %.%', t, c.conname;
    END LOOP;
  END LOOP;

  IF to_regclass('public.system_settings') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS system_settings_org_key_idx
      ON public.system_settings (organization_id, key);
  END IF;
  IF to_regclass('public.feature_flags') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS feature_flags_org_key_idx
      ON public.feature_flags (organization_id, key);
  END IF;
END $$;

-- ── 4. Fan the platform-global rows out, one copy per studio ────────────────
--
-- Every non-branch row is configuration that all six studios have been sharing
-- one copy of. Each studio keeps exactly what it sees today: the row is copied
-- to every organisation, so nobody's gym name, currency, timezone, permission
-- matrix or feature flags change on the deploy that scopes them.
--
-- Copy-per-studio rather than assign-to-one, because assigning would give the
-- configuration to a single arbitrary studio and blank it for the other five.
--
-- ON CONFLICT DO NOTHING guards re-runs and the case where a studio was already
-- attributed a key by hand. It resolves against the per-studio unique index
-- created in step 3, which is why that step runs first — see the ordering note
-- in the header.
--
-- Branch rows are excluded: a branch is owned by one studio, never a default.
DO $$
DECLARE
  org_count INT;
  copied    BIGINT := 0;
  n         BIGINT;
BEGIN
  SELECT count(*) INTO org_count FROM organizations;
  IF org_count = 0 THEN
    RAISE NOTICE '180: no organisations present — nothing to fan out';
    RETURN;
  END IF;

  IF to_regclass('public.system_settings') IS NOT NULL THEN
    INSERT INTO system_settings (key, value, type, description, updated_by, updated_at, organization_id)
    SELECT s.key, s.value, s.type, s.description, s.updated_by, s.updated_at, o.id
      FROM system_settings s
     CROSS JOIN organizations o
     WHERE s.organization_id IS NULL
       AND s.key NOT LIKE 'branch\_%'
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    copied := copied + n;
  END IF;

  IF to_regclass('public.feature_flags') IS NOT NULL THEN
    INSERT INTO feature_flags (key, value, description, updated_at, organization_id)
    SELECT f.key, f.value, f.description, f.updated_at, o.id
      FROM feature_flags f
     CROSS JOIN organizations o
     WHERE f.organization_id IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    copied := copied + n;
  END IF;

  RAISE NOTICE '180: fanned % row(s) out across % studio(s)', copied, org_count;
END $$;


-- ── 5. Index and enable RLS ─────────────────────────────────────────────────
--
-- Migration 157 generated one policy per table carrying organization_id, and
-- it has already run. It does not re-run, so these two tables get their
-- policies here — the same mechanism 174 used for the tables it retrofitted.
--
-- The STRICT shape, not the shared one. 157 keeps a `shared_tables` list whose
-- policy also admits `organization_id IS NULL`, for tables that legitimately
-- mix studio rows with platform-global content (the 890-row exercise library,
-- diet templates, reference landmarks). Neither of these tables is that: after
-- step 4 every row a studio can act on carries its organisation, and admitting
-- NULL here would re-open the write path this migration closes — a tenant could
-- INSERT a NULL-org row and hand it straight back to every studio.
--
-- So `system_settings` and `feature_flags` must NOT be added to 157's
-- shared_tables list, nor to SHARED_TABLES in migrations.orgNotNull.test.js.
DO $$
DECLARE
  t TEXT;
BEGIN
  -- app_tenant is created by 157. On a database that has not run it (a fresh
  -- CI container built from schema.sql alone), skip rather than fail: the
  -- policies are meaningless without the role, and the application-layer
  -- scoping in routes/settings.js is what protects those environments.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    RAISE NOTICE '180: app_tenant role absent — skipping RLS policies';
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['system_settings', 'feature_flags']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant '
      || 'USING (organization_id::text = current_setting(''app.org_id'', true)) '
      || 'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))',
      t
    );
  END LOOP;
END $$;

-- Supporting index for the branch listing, which is the one query that scans
-- by key pattern within a studio rather than looking a key up directly.
CREATE INDEX IF NOT EXISTS system_settings_org_idx ON system_settings (organization_id);
CREATE INDEX IF NOT EXISTS feature_flags_org_idx   ON feature_flags (organization_id);


-- ── 6. Report what could not be attributed ──────────────────────────────────
--
-- WARN, never RAISE. Following 172 and 174: an EXCEPTION here aborts the
-- migration and the deploy with it, and these rows are already wrong. The
-- migration runner forwards WARNING to the deploy log (see the `notice`
-- listener in db/migrate.js), so this is read rather than swallowed.
--
-- An unattributable branch row is one that NO live client references. Nothing
-- points at it, so nothing breaks by it becoming invisible — but a studio that
-- created a branch and has not yet assigned anyone to it will find it gone,
-- which is worth a line in the log rather than a support ticket.
DO $$
DECLARE
  orphan_branches BIGINT := 0;
  split_branches  BIGINT := 0;
BEGIN
  IF to_regclass('public.system_settings') IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO orphan_branches
    FROM system_settings
   WHERE key LIKE 'branch\_%' AND organization_id IS NULL;

  IF to_regclass('public.pt_clients') IS NOT NULL THEN
    SELECT count(*) INTO split_branches
      FROM (
        SELECT c.branch_id
          FROM pt_clients c
         WHERE c.branch_id IS NOT NULL AND c.organization_id IS NOT NULL
           AND c.deleted_at IS NULL
         GROUP BY c.branch_id
        HAVING count(DISTINCT c.organization_id) > 1
      ) x;
  END IF;

  IF orphan_branches > 0 THEN
    RAISE WARNING
      '180: % branch row(s) could not be attributed to a studio — no live client '
      'references them. They are invisible to every studio from this deploy onward. '
      'Assign system_settings.organization_id by hand to restore one.',
      orphan_branches;
  END IF;

  IF split_branches > 0 THEN
    RAISE WARNING
      '180: % branch key(s) are referenced by clients in MORE THAN ONE studio. '
      'That is pre-existing cross-tenant data and this migration will not guess an '
      'owner. Reassign the affected pt_clients.branch_id values, then set '
      'system_settings.organization_id by hand.',
      split_branches;
  END IF;

  RAISE NOTICE '180: settings are now per-studio. % orphan branch row(s), % split key(s).',
    orphan_branches, split_branches;
END $$;
