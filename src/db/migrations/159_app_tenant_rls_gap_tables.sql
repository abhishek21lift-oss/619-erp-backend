-- 159_app_tenant_rls_gap_tables.sql
--
-- The tables migration 157 could not see, and what they would have done.
--
-- 157 discovers its policy list from the schema: every table carrying an
-- `organization_id` column gets a `tenant_isolation` policy. That is the right
-- way to build the list — a tenant table added next month is covered without
-- anyone remembering — but it silently excludes tenant-owned data that carries
-- no such column. Eleven tables in `public` have RLS ENABLED (the convention
-- since migration 104, tightened wholesale by 131) and no policy naming
-- app_tenant at all.
--
-- A table with RLS enabled and no applicable policy does not raise. It returns
-- zero rows. So on the day DATABASE_URL is pointed at app_tenant, these eleven
-- would have gone quiet — no error, no log line, nothing to page on. Verified
-- against a real database with the full schema, all 158 migrations and the real
-- app_tenant role:
--
--   SELECT count(*) FROM organizations       as postgres → 2   as app_tenant → 0
--   SELECT count(*) FROM subscription_plans  as postgres → 4   as app_tenant → 0
--   SELECT count(*) FROM pt_clients          as postgres → 1   as app_tenant → 1  (157 works)
--
-- That is the failure mode TENANT-RLS-PLAN.md's rollout step 4 ("fix every
-- permission error that surfaces") cannot catch, because RLS denies by
-- filtering rather than by erroring. The blast radius, counted in source files
-- that query each table: organizations 27 — every authenticated request joins
-- it — subscription_plans 5, workout_session_exercises 3, subscription_coupons
-- 2, workout_sets 2, pt_lifestyle_assessments 2, and four more. Billing,
-- workout logging, assessments and studio branding, all returning empty.
--
-- Three shapes, because these tables reach the tenant boundary three different
-- ways. Granted ONLY to app_tenant, per the GUC caution in TENANT-RLS-PLAN.md:
-- never `public`, `anon` or `authenticated`, and the existing deny-all policies
-- for those roles are untouched.

-- ── 1. organizations — the boundary itself ──────────────────────────────────
--
-- The tenant column here is `id`. There is no `organization_id` on the
-- organizations table, which is precisely why 157's schema scan skipped it.
--
-- Fail-closed exactly as 157's tables do: a connection with no app.org_id set
-- matches nothing. That is deliberate and consistent — see the note at the
-- bottom about platform-wide super-admin traffic, which is a property of the
-- whole design rather than of this table.
DO $$
BEGIN
  IF to_regclass('public.organizations') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.organizations';
    EXECUTE
      'CREATE POLICY tenant_isolation ON public.organizations FOR ALL TO app_tenant '
      || 'USING (id::text = current_setting(''app.org_id'', true)) '
      || 'WITH CHECK (id::text = current_setting(''app.org_id'', true))';
  END IF;
END $$;

-- ── 2. Platform-global catalogue — no tenant dimension at all ───────────────
--
-- These are the SaaS billing catalogue the studios buy FROM, not data any
-- studio owns: the plan list, the coupon list, and the singleton row holding
-- the platform's own UPI details. Every tenant must be able to read them —
-- scoping them to an org would empty the pricing page for all six studios at
-- once, the same trap the 890-row exercise library posed in
-- TENANT-RLS-PLAN.md.
--
-- WITH CHECK (true) rather than a read-only policy: the platform console
-- writes these rows, and under this design it connects as app_tenant too. Who
-- may write them stays where it already is — requireSuperAdmin at the route —
-- which is exactly the authority that governs them today while the app
-- connects as `postgres`. This is therefore not a widening: it preserves the
-- current boundary rather than inventing a database-level one that the
-- platform console would immediately need to work around.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['subscription_plans', 'subscription_coupons', 'platform_payment_settings']
  LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant '
        || 'USING (true) WITH CHECK (true)', tbl);
    END IF;
  END LOOP;
END $$;

-- ── 3. Child rows — the boundary lives on the parent ────────────────────────
--
-- These five carry no organization_id because they are detail rows hanging off
-- something that does. Their tenant is whoever owns the parent.
--
-- The org check is written out against the parent's own column rather than
-- left to the parent's RLS policy to apply through the subquery. Postgres does
-- filter a subquery by the referenced table's policies, so the shorter form
-- would work — but a security boundary should not depend on the reader knowing
-- that, and the explicit predicate keeps each policy true on its own terms.
--
-- Every FK used below is already indexed (wse_session_idx, wsets_exercise_idx,
-- pla_client_date_idx, pna_client_date_idx, pfmh_form_idx), so these resolve on
-- an index rather than a scan per row.
DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- child table,                    child FK,              parent table,        parent key
      ('workout_session_exercises',      'session_id',          'workout_sessions',  'id'),
      ('pt_lifestyle_assessments',       'client_id',           'pt_clients',        'id'),
      ('pt_nutrition_assessments',       'client_id',           'pt_clients',        'id'),
      ('pt_family_medical_history',      'parq_form_id',        'pt_parq_forms',     'id')
    ) AS t(child, fk, parent, parent_key)
  LOOP
    IF to_regclass('public.' || spec.child) IS NOT NULL
       AND to_regclass('public.' || spec.parent) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', spec.child);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', spec.child);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant '
        || 'USING (EXISTS (SELECT 1 FROM public.%I p WHERE p.%I = public.%I.%I '
        || '  AND p.organization_id::text = current_setting(''app.org_id'', true))) '
        || 'WITH CHECK (EXISTS (SELECT 1 FROM public.%I p WHERE p.%I = public.%I.%I '
        || '  AND p.organization_id::text = current_setting(''app.org_id'', true)))',
        spec.child,
        spec.parent, spec.parent_key, spec.child, spec.fk,
        spec.parent, spec.parent_key, spec.child, spec.fk);
    END IF;
  END LOOP;
END $$;

-- workout_sets is a grandchild: it points at workout_session_exercises, which
-- points at workout_sessions, which is where organization_id lives. Two hops,
-- so it does not fit the single-parent loop above.
DO $$
BEGIN
  IF to_regclass('public.workout_sets') IS NOT NULL
     AND to_regclass('public.workout_session_exercises') IS NOT NULL
     AND to_regclass('public.workout_sessions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.workout_sets ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.workout_sets';
    EXECUTE
      'CREATE POLICY tenant_isolation ON public.workout_sets FOR ALL TO app_tenant '
      || 'USING (EXISTS (SELECT 1 FROM public.workout_session_exercises wse '
      || '  JOIN public.workout_sessions ws ON ws.id = wse.session_id '
      || ' WHERE wse.id = public.workout_sets.session_exercise_id '
      || '   AND ws.organization_id::text = current_setting(''app.org_id'', true))) '
      || 'WITH CHECK (EXISTS (SELECT 1 FROM public.workout_session_exercises wse '
      || '  JOIN public.workout_sessions ws ON ws.id = wse.session_id '
      || ' WHERE wse.id = public.workout_sets.session_exercise_id '
      || '   AND ws.organization_id::text = current_setting(''app.org_id'', true)))';
  END IF;
END $$;

-- ── Deliberately left with no policy ────────────────────────────────────────
--
-- agent_tasks and agent_audit_log get nothing, and so stay denied to
-- app_tenant. Both are keyed on user_id with no route to an organization, and
-- neither is queried by a single source file in routes/, modules/, lib/ or
-- services/ — they are unused scaffolding. Denied is the fail-closed answer
-- for a table nobody reads; inventing a policy for one would be inventing a
-- tenant boundary for data that has no traffic to validate it against.
--
-- If either is ever wired up, it needs a policy here first, and the reader
-- will find this note rather than a silent zero-row bug.

-- ── What this migration does NOT fix ────────────────────────────────────────
--
-- A connection with no app.org_id set matches no strict policy — 157's tables
-- and now organizations alike — so platform-wide super-admin traffic, which
-- resolves to a null org by design (tenantScope's `applyFilter = false` path),
-- would read zero rows as app_tenant. That is a property of the whole design,
-- not of these eleven tables, and it needs its own answer before the cutover:
-- either the platform console keeps a BYPASSRLS connection of its own, or
-- app.org_id gains an explicit platform-wide sentinel the policies honour.
-- Recorded here because this migration is where somebody will be looking when
-- they hit it.
