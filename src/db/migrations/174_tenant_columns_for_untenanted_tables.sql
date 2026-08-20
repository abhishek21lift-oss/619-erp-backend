-- ============================================================================
-- 174_tenant_columns_for_untenanted_tables.sql
--
-- The twelve tables that hold tenant business data and never received an
-- organization_id column.
--
-- ── Why they were missed ────────────────────────────────────────────────────
--
-- The tenant boundary in this codebase is the presence of `organization_id`.
-- Both guard mechanisms derive their scope from that same column:
--
--   · tenantScope.convention.test.js builds its watchlist by scanning these
--     migrations for tables carrying organization_id, and
--   · 157_app_tenant_role_and_rls.sql generates one RLS policy per table
--     carrying organization_id.
--
-- So a table that never got the column is not merely unprotected — it is, by
-- both mechanisms' own definition, not a tenant table. Neither looks at it,
-- and the routes serving it passed every check on every commit while reading
-- and writing across every studio on the platform.
--
-- The affected surfaces, all confirmed reachable from the shipped frontend:
--
--   pt_lifestyle_assessments   sleep, stress, smoking, alcohol, coach notes
--   pt_nutrition_assessments   allergies, medical_conditions, medical_notes
--   session_balance            PT sessions sold, joined to client name+mobile
--   pt_packages                PT product catalogue and pricing
--   automation_rules           message templates and triggers
--   communication_logs         every message sent, with recipient phone
--   campaigns                  marketing campaigns and their performance
--   offers                     discount codes and redemption counts
--   feedback                   member feedback and staff replies
--   integrations               third-party API keys
--   plans                      membership pricing
--   meals                      diet catalogue
--
-- ── What this migration does NOT do ─────────────────────────────────────────
--
-- It does not fan catalogue rows out per organization. That was considered for
-- plans / meals / pt_packages, where every studio currently sees every row and
-- a per-studio copy would preserve exactly today's behaviour. It is rejected
-- because those ids are referenced elsewhere — payment_orders.plan_id and
-- diet_plan_meals.meal_id both point at them — so duplicating rows under new
-- ids would either break those references or need a second rewrite pass across
-- tables this migration has no business touching.
--
-- It also never RAISEs on un-attributable rows, following 172's precedent: an
-- EXCEPTION here aborts the migration and the deploy with it, and the rows are
-- already wrong. It WARNs with exact counts instead, and scripts/orphan-rows.js
-- lists them for an operator to assign.
--
-- ── Reading order ───────────────────────────────────────────────────────────
--   1. add the columns
--   2. backfill from whatever real signal each table has
--   3. single-organization fallback
--   4. replace the globally-unique constraints that would otherwise collide
--   5. index, and create module_records properly
--   6. tighten to NOT NULL where nothing is left over
-- ============================================================================


-- ── 1. Columns ──────────────────────────────────────────────────────────────
--
-- ON DELETE SET NULL matches the 25 existing retrofits in these migrations.
-- Organisation deletion is an application-level operation (the platform
-- console suspends rather than deletes), so the cascade behaviour is not
-- load-bearing and consistency with the surrounding schema is worth more.
--
-- ── Why these are twelve statements and not a loop ──────────────────────────
--
-- The first draft of this migration added all twelve inside a
-- `FOREACH t IN ARRAY … EXECUTE format(…)` loop, which is shorter, and which
-- would have quietly defeated the entire point of the migration.
--
-- Every mechanism that knows which tables are tenant tables learns it by
-- READING THESE FILES with a regular expression: tenantScope.convention.test.js
-- builds its watchlist that way, 157_app_tenant_role_and_rls.sql generates its
-- policy list that way, and the new tenantColumns.convention.test.js checks its
-- invariant that way. A column added through a dynamic EXECUTE is invisible to
-- all three — so the twelve tables would have gained the column in the database
-- and remained, to every guard in the repository, exactly as unwatched as they
-- were before. That is the original bug, reintroduced by the fix for it.
--
-- `ALTER TABLE IF EXISTS` rather than a to_regclass guard, for the same reason:
-- it keeps the statement literal and greppable while still tolerating an
-- environment that never created the table.
ALTER TABLE IF EXISTS pt_lifestyle_assessments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS pt_nutrition_assessments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS session_balance          ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS pt_packages              ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS automation_rules         ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS communication_logs       ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS campaigns                ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS offers                   ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS feedback                 ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS integrations             ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS plans                    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS meals                    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;


-- ── 2. Backfill from each table's own attribution signal ────────────────────
--
-- Each UPDATE is written to touch only rows that are still NULL, so the
-- migration is re-runnable and a later hand-attribution is never overwritten.

-- The two assessment tables are the clean case: both carry
-- `client_id TEXT NOT NULL REFERENCES pt_clients(id)`, and pt_clients has
-- carried organization_id since 078. Every row is attributable.
DO $$ BEGIN
  IF to_regclass('public.pt_lifestyle_assessments') IS NOT NULL THEN
    UPDATE pt_lifestyle_assessments a
       SET organization_id = c.organization_id
      FROM pt_clients c
     WHERE c.id = a.client_id
       AND a.organization_id IS NULL
       AND c.organization_id IS NOT NULL;
  END IF;
  IF to_regclass('public.pt_nutrition_assessments') IS NOT NULL THEN
    UPDATE pt_nutrition_assessments a
       SET organization_id = c.organization_id
      FROM pt_clients c
     WHERE c.id = a.client_id
       AND a.organization_id IS NULL
       AND c.organization_id IS NOT NULL;
  END IF;
END $$;

-- session_balance.client_id and feedback.member_id were declared
-- `REFERENCES clients(id)` — the legacy table migration 170 dropped, taking
-- their foreign keys with it (170 resolves the FK set from pg_catalog and
-- drops each one). Both columns are therefore now unconstrained TEXT holding
-- legacy ids that may or may not resolve against pt_clients. Joining anyway is
-- correct and cheap: rows whose id happens to match a live client are
-- attributed, and the rest fall through to the fallback below.
DO $$ BEGIN
  IF to_regclass('public.session_balance') IS NOT NULL THEN
    UPDATE session_balance sb
       SET organization_id = c.organization_id
      FROM pt_clients c
     WHERE c.id = sb.client_id
       AND sb.organization_id IS NULL
       AND c.organization_id IS NOT NULL;
  END IF;
  IF to_regclass('public.feedback') IS NOT NULL THEN
    UPDATE feedback f
       SET organization_id = c.organization_id
      FROM pt_clients c
     WHERE c.id = f.member_id
       AND f.organization_id IS NULL
       AND c.organization_id IS NOT NULL;
  END IF;
END $$;

-- campaigns, offers and automation_rules all carry created_by. On
-- automation_rules it is a real FK to users(id); on the other two it is a bare
-- TEXT column holding the same thing, so all three resolve the same way.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns', 'offers', 'automation_rules']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format(
      'UPDATE public.%I x SET organization_id = u.organization_id '
      || '  FROM users u '
      || ' WHERE u.id = x.created_by '
      || '   AND x.organization_id IS NULL '
      || '   AND u.organization_id IS NOT NULL', t
    );
  END LOOP;
END $$;

-- communication_logs reaches an organisation two ways: through the automation
-- rule that produced it (now attributed, above), or through the client it was
-- sent to. Rule first — it is a real FK and therefore reliable — then the
-- recipient, which is only meaningful for recipient_type = 'client'.
DO $$ BEGIN
  IF to_regclass('public.communication_logs') IS NOT NULL THEN
    UPDATE communication_logs cl
       SET organization_id = ar.organization_id
      FROM automation_rules ar
     WHERE ar.id = cl.automation_rule_id
       AND cl.organization_id IS NULL
       AND ar.organization_id IS NOT NULL;

    UPDATE communication_logs cl
       SET organization_id = c.organization_id
      FROM pt_clients c
     WHERE c.id = cl.recipient_id
       AND cl.recipient_type = 'client'
       AND cl.organization_id IS NULL
       AND c.organization_id IS NOT NULL;
  END IF;
END $$;

-- plans, pt_packages, integrations and meals have no attribution signal at
-- all: they were built as single-tenant global catalogues and carry no author,
-- owner or client reference. Only the fallback below can place them.


-- ── 3. Single-organisation fallback ─────────────────────────────────────────
--
-- Where the whole database holds exactly one organisation, every remaining row
-- belongs to it — there is nowhere else it could belong. That covers every
-- development database, CI, and any single-studio production, which is the
-- state these single-tenant-era tables were written for.
--
-- Deliberately does nothing when several organisations exist. Guessing there
-- would attribute one studio's pricing and API keys to another, which is a
-- worse outcome than the row staying invisible until somebody assigns it.
DO $$
DECLARE
  org_count INT;
  only_org  UUID;
  t         TEXT;
  moved     BIGINT;
  total     BIGINT := 0;
BEGIN
  SELECT count(*) INTO org_count FROM organizations;
  IF org_count <> 1 THEN
    RAISE NOTICE '174: % organisations present — skipping single-org fallback', org_count;
    RETURN;
  END IF;
  SELECT id INTO only_org FROM organizations;

  FOREACH t IN ARRAY ARRAY[
    'pt_lifestyle_assessments', 'pt_nutrition_assessments', 'session_balance',
    'pt_packages', 'automation_rules', 'communication_logs', 'campaigns',
    'offers', 'feedback', 'integrations', 'plans', 'meals'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format(
      'UPDATE public.%I SET organization_id = $1 WHERE organization_id IS NULL', t
    ) USING only_org;
    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;
  END LOOP;

  RAISE NOTICE '174: single-org fallback assigned % row(s) to %', total, only_org;
END $$;


-- ── 4. Constraints that were globally unique and must now be per-studio ─────
--
-- This is the half of the retrofit that a column alone does not cover, and
-- skipping it would leave the feature broken for the SECOND studio rather than
-- leaking to the first:
--
--   offers.code      UNIQUE  → studio B cannot create the code studio A used
--   pt_packages.name UNIQUE  → studio B cannot name a package "12 Sessions"
--   integrations     PK (id) → only one studio on the platform can connect
--                              Razorpay, because the row IS the integration
--
-- Constraint names are resolved from pg_catalog rather than assumed, because
-- these tables were created by `CREATE TABLE IF NOT EXISTS` in migrations that
-- ran at different times against differently-shaped databases, and an inline
-- UNIQUE gets a generated name that is not guaranteed across environments.

-- offers.code: unique per studio.
DO $$
DECLARE
  c RECORD;
BEGIN
  IF to_regclass('public.offers') IS NULL THEN RETURN; END IF;
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public' AND rel.relname = 'offers'
       AND con.contype = 'u'
       AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
              FROM unnest(con.conkey) k
              JOIN pg_attribute att
                ON att.attrelid = con.conrelid AND att.attnum = k) = ARRAY['code']
  LOOP
    EXECUTE format('ALTER TABLE public.offers DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE '174: dropped global unique constraint offers.%', c.conname;
  END LOOP;
  -- A unique INDEX rather than a constraint, on purpose: NULLs are distinct in
  -- both, but an index can be created concurrently later if this table ever
  -- grows, and it is what ON CONFLICT needs to target.
  CREATE UNIQUE INDEX IF NOT EXISTS offers_org_code_key
    ON public.offers (organization_id, code) WHERE code IS NOT NULL;
END $$;

-- pt_packages.name: unique per studio.
DO $$
DECLARE
  c RECORD;
BEGIN
  IF to_regclass('public.pt_packages') IS NULL THEN RETURN; END IF;
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public' AND rel.relname = 'pt_packages'
       AND con.contype = 'u'
       AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
              FROM unnest(con.conkey) k
              JOIN pg_attribute att
                ON att.attrelid = con.conrelid AND att.attnum = k) = ARRAY['name']
  LOOP
    EXECUTE format('ALTER TABLE public.pt_packages DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE '174: dropped global unique constraint pt_packages.%', c.conname;
  END LOOP;
  CREATE UNIQUE INDEX IF NOT EXISTS pt_packages_org_name_key
    ON public.pt_packages (organization_id, name);
END $$;

-- integrations: the primary key IS the integration name ('razorpay',
-- 'sendgrid'), so one row per platform. It has to become one row per studio
-- per integration.
--
-- The replacement is a unique index on (organization_id, id) rather than a new
-- composite PRIMARY KEY, because a PK requires NOT NULL and this migration
-- cannot promise every legacy integrations row is attributable. A unique index
-- accepts the leftovers, and routes/integrations.js targets it with
-- ON CONFLICT (organization_id, id). Rows the fallback could not place keep a
-- NULL organization_id and are invisible to every studio — which for a row
-- holding an unattributable third-party API key is the right outcome: the
-- studio reconnects the integration and gets a key that is definitely theirs.
DO $$
DECLARE
  c RECORD;
BEGIN
  IF to_regclass('public.integrations') IS NULL THEN RETURN; END IF;
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public' AND rel.relname = 'integrations'
       AND con.contype IN ('p', 'u')
       AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
              FROM unnest(con.conkey) k
              JOIN pg_attribute att
                ON att.attrelid = con.conrelid AND att.attnum = k) = ARRAY['id']
  LOOP
    EXECUTE format('ALTER TABLE public.integrations DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE '174: dropped platform-wide key integrations.%', c.conname;
  END LOOP;
  CREATE UNIQUE INDEX IF NOT EXISTS integrations_org_id_key
    ON public.integrations (organization_id, id);
END $$;

-- session_balance UNIQUE (client_id, package_name) is left alone: client_id
-- already resolves to exactly one organisation, so the constraint is per-studio
-- already and rewriting it would add risk for no isolation gain.


-- ── 5. Indexes, and module_records ──────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pt_lifestyle_assessments', 'pt_nutrition_assessments', 'session_balance',
    'pt_packages', 'automation_rules', 'communication_logs', 'campaigns',
    'offers', 'feedback', 'integrations', 'plans', 'meals'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_organization_id ON public.%I (organization_id)', t, t
    );
  END LOOP;
END $$;

-- module_records backs ModuleWorkspace on eight (chrome) tabs — attendance,
-- training, finance, settings, engagement, reports, appointments, insights —
-- and appears in no migration and no schema file. Whatever created it in an
-- environment where it exists did so out of band, which is exactly why neither
-- the RLS generator nor the convention test could see it.
--
-- CREATE TABLE IF NOT EXISTS plus the ADD COLUMN below resolves both possible
-- states without needing to know which one production is in: if the table was
-- never created, the eight tabs stop returning 503; if it was created out of
-- band, it gains the tenant column and keeps its rows.
CREATE TABLE IF NOT EXISTS module_records (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  module_key  TEXT NOT NULL,
  title       TEXT NOT NULL,
  owner       TEXT,
  status      TEXT,
  priority    TEXT,
  amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  due_date    DATE,
  channel     TEXT,
  notes       TEXT,
  branch_id   TEXT,
  created_by  TEXT,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE module_records
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

DO $$ BEGIN
  UPDATE module_records m
     SET organization_id = u.organization_id
    FROM users u
   WHERE u.id = m.created_by
     AND m.organization_id IS NULL
     AND u.organization_id IS NOT NULL;
END $$;

DO $$
DECLARE
  org_count INT;
  only_org  UUID;
BEGIN
  SELECT count(*) INTO org_count FROM organizations;
  IF org_count = 1 THEN
    SELECT id INTO only_org FROM organizations;
    UPDATE module_records SET organization_id = only_org WHERE organization_id IS NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_module_records_organization_id
  ON module_records (organization_id);
CREATE INDEX IF NOT EXISTS idx_module_records_key
  ON module_records (module_key, due_date) WHERE deleted_at IS NULL;

-- RLS for module_records, matching the house pattern (130, 148, 169).
--
-- Caught by rls.convention.test.js, which is the point of that test: it asserts
-- that every table a migration CREATES enables RLS and revokes the PostgREST
-- roles. The first draft of this migration created module_records and did
-- neither, and the guard failed the build — which is exactly the outcome the
-- table's whole history argues for, since it was originally created outside the
-- migration system and so was invisible to every mechanism that reads these
-- files.
--
-- Tenant-scoped rather than user-scoped: these are studio operational records,
-- readable by the studio's staff, so the predicate is the same organization_id
-- comparison 157 generates for every other tenant table.
ALTER TABLE module_records ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.module_records';
    EXECUTE
      'CREATE POLICY tenant_isolation ON public.module_records FOR ALL TO app_tenant '
      || 'USING (organization_id::text = current_setting(''app.org_id'', true)) '
      || 'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.module_records FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.module_records FROM authenticated';
  END IF;
END $$;

-- The twelve tables 174 retrofits are NOT given policies here. They get them
-- from 157's schema scan, which discovers every table carrying an
-- organization_id — and as of this migration, they all do. Re-running 157
-- after this one (it is idempotent) is what activates them; the RLS cutover
-- sequence in TENANT-RLS-PLAN.md covers that step.


-- ── 6. Tighten to NOT NULL where the backfill was complete ──────────────────
--
-- Same shape as 172: tighten what is clean, WARN about what is not, and never
-- abort. A table left nullable is still scoped at the application layer — the
-- leftover rows simply match no studio's filter and stay invisible until an
-- operator assigns them. `node scripts/orphan-rows.js` lists them.
DO $$
DECLARE
  t          TEXT;
  null_count BIGINT;
  tightened  INT := 0;
  skipped    INT := 0;
  already    INT := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pt_lifestyle_assessments', 'pt_nutrition_assessments', 'session_balance',
    'pt_packages', 'automation_rules', 'communication_logs', 'campaigns',
    'offers', 'feedback', 'integrations', 'plans', 'meals', 'module_records'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t
         AND column_name = 'organization_id' AND is_nullable = 'YES'
    ) THEN
      already := already + 1;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', t)
       INTO null_count;

    IF null_count = 0 THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', t);
      tightened := tightened + 1;
    ELSE
      skipped := skipped + 1;
      RAISE WARNING
        '174: % left nullable — % row(s) could not be attributed to a studio. '
        'They are invisible to every studio from this deploy onward. '
        'Run `node scripts/orphan-rows.js` to list them, assign organization_id, '
        'and re-run this migration to tighten the column.',
        t, null_count;
    END IF;
  END LOOP;

  RAISE NOTICE '174: % tightened, % left nullable (orphans present), % already NOT NULL.',
    tightened, skipped, already;
END $$;
