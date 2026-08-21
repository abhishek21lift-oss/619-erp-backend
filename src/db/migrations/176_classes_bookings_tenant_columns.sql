-- 176_classes_bookings_tenant_columns.sql
--
-- Give the classes/bookings feature a tenant boundary.
--
-- WHY THIS IS NOT COVERED BY 174
--
-- 174 retrofitted the twelve tables the API read without a tenant filter.
-- These five were excluded deliberately and listed in KNOWN_GAPS in
-- tenantColumns.convention.test.js as "legacy members feature / not yet
-- retrofitted". That reason was wrong on the facts: the module is mounted at
-- BOTH /api/bookings and /api/v1/bookings, /api/classes/sessions is mounted
-- too, and src/app/(bare)/member/classes/page.tsx calls api.bookings.create —
-- a shipped page reachable by the `member` accounts client activation creates.
--
-- Nothing had leaked only because every table was empty. The first member to
-- book a class would have created a row visible to all six studios.
--
-- WHAT MADE THIS CHEAP
--
-- Verified read-only against production before writing this:
--
--   bookings            0 rows
--   class_sessions      0 rows
--   member_memberships  0 rows
--   attendance          0 rows   (only writer is bookings.service.js checkIn;
--                                 the live PT table is attendance_logs, which
--                                 already carries organization_id)
--   class_templates     4 rows   ct-yoga, ct-hiit, ct-spin, ct-zumba
--
-- So unlike 174 there is no backfill problem at all for four of the five:
-- NOT NULL applies directly, with no orphan rows and no warning to chase.
--
-- class_templates is the exception, and takes the SHARED shape instead. Its
-- four rows are dated 2026-04-29 — the same day as plan-drop, and two to three
-- months before the earliest organisation (2026-07-20). They are pre-tenancy
-- seed content that no studio created, and they are generic class types
-- ("Yoga Flow", "HIIT Burn"), which is exactly what `exercises` and `meals`
-- are: a platform reference library a studio draws from. Same shape, same
-- reason. A studio's own templates get stamped on insert and stay private.
--
-- Columns are added as five LITERAL ALTER TABLE statements, not a loop. 174
-- learned this the hard way: a dynamic FOREACH produces an identical database
-- and leaves every regex-based guard in this repo blind to the tables it
-- touched. tenantColumns.convention.test.js asserts the literal form.

-- ── 1. Columns ──────────────────────────────────────────────────────────────
ALTER TABLE bookings            ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE class_sessions      ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE class_templates     ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE member_memberships  ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE attendance          ADD COLUMN IF NOT EXISTS organization_id UUID;

-- ── 2. Foreign keys ─────────────────────────────────────────────────────────
-- ON DELETE CASCADE: these are per-studio operational rows with no meaning
-- once the studio is gone, which is how every other tenant table in this
-- schema is wired.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bookings','class_sessions','class_templates',
                           'member_memberships','attendance']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass('public.' || t)
         AND conname  = t || '_organization_id_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (organization_id) '
        || 'REFERENCES organizations(id) ON DELETE CASCADE',
        t, t || '_organization_id_fkey'
      );
    END IF;
  END LOOP;
END $$;

-- ── 3. Indexes ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS bookings_org_idx           ON bookings (organization_id);
CREATE INDEX IF NOT EXISTS class_sessions_org_idx     ON class_sessions (organization_id);
CREATE INDEX IF NOT EXISTS class_templates_org_idx    ON class_templates (organization_id);
CREATE INDEX IF NOT EXISTS member_memberships_org_idx ON member_memberships (organization_id);
CREATE INDEX IF NOT EXISTS attendance_org_idx         ON attendance (organization_id);

-- ── 4. NOT NULL on the four that are empty ──────────────────────────────────
--
-- Guarded by an actual row count rather than assumed: this migration may run
-- against a database where the feature HAS been used (a fork, a restored
-- backup, a staging box someone clicked through). If any row lacks an org, the
-- column stays nullable and the migration says so rather than aborting the
-- deploy — the same warn-don't-abort posture as 172 and 174.
DO $$
DECLARE
  t          TEXT;
  null_count BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bookings','class_sessions','member_memberships','attendance']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', t)
       INTO null_count;

    IF null_count = 0 THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', t);
    ELSE
      RAISE WARNING
        '176: %.organization_id left nullable — % row(s) have no organisation. '
        'This database has used the classes feature; attribute those rows and re-run.',
        t, null_count;
    END IF;
  END LOOP;
END $$;

-- ── 5. RLS: strict for the four, shared for the template library ────────────
--
-- Created here rather than left to 157. 157 already ran, and on a fresh
-- install it runs BEFORE this migration exists — so a table that gets its
-- column here would never appear in 157's schema scan. Combined with 131
-- having converged every table in public to RLS-enabled, that leaves RLS on
-- with no policy naming app_tenant, which does not raise: it returns zero
-- rows. 174's first draft made exactly this mistake and CI caught it.
DO $$
DECLARE t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    RAISE NOTICE '176: app_tenant absent, skipping policy creation';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['bookings','class_sessions','member_memberships','attendance']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant '
      || 'USING (organization_id::text = current_setting(''app.org_id'', true)) '
      || 'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))', t
    );
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN RETURN; END IF;
  IF to_regclass('public.class_templates') IS NULL THEN RETURN; END IF;
  ALTER TABLE public.class_templates ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON public.class_templates;
  CREATE POLICY tenant_isolation ON public.class_templates FOR ALL TO app_tenant
    USING (organization_id::text = current_setting('app.org_id', true) OR organization_id IS NULL)
    WITH CHECK (organization_id::text = current_setting('app.org_id', true) OR organization_id IS NULL);
END $$;

-- ── 6. PostgREST roles never reach these tables ─────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bookings','class_sessions','class_templates',
                           'member_memberships','attendance']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
