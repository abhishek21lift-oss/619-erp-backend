-- ============================================================
-- 188_app_tenant_policy_gap.sql
--
-- Fifty-five tenant-plane tables have RLS enabled and NO policy naming
-- app_tenant. The moment DATABASE_URL points at app_tenant, every one of
-- them returns zero rows.
--
-- ── How this was found, and proved ──────────────────────────
--
-- Detected by cross-referencing the domain manifest's tenant/portal-plane
-- tables against pg_policies:
--
--   SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--    WHERE n.nspname='public' AND c.relkind='r'
--      AND NOT EXISTS (SELECT 1 FROM pg_policies p
--                       WHERE p.schemaname='public' AND p.tablename=c.relname
--                         AND 'app_tenant' = ANY(p.roles));
--
-- Proved against a real app_tenant connection on the rls-proof database,
-- not inferred from catalogue metadata:
--
--   as postgres (owner):  system_settings=8   muscles=24
--   as app_tenant, with app.org_id set to a real org:
--                         system_settings=0   muscles=0
--
-- Zero rows, not an error. That is the whole danger: RLS denies by
-- filtering, so this class of break renders as an empty screen and not as
-- a 500 anybody would page on.
--
-- ── Why it happened ─────────────────────────────────────────
--
-- 157_app_tenant_role_and_rls.sql generated its policy list by discovering
-- tables that carry an `organization_id` column. Not one of these 55 has
-- that column — every one of them resolves its studio through a parent row
-- instead, or is genuinely global. So the generator did not skip them by
-- accident; they were never in its search space at all. The same blind spot
-- is documented in TENANT-RLS-PLAN.md ("it derives its table list from the
-- migrations by scanning for organization_id — which is a blind spot").
--
-- The E2E cross-tenant suite passing 23/23 against an app_tenant connection
-- did not catch this either, because every table it touches (pt_clients,
-- pt_payments, pt_trainers, leave_requests, pt_packages) is one of the ones
-- that already HAS a policy. A green suite that never reaches the broken
-- surface is not evidence about that surface.
--
-- ── What this changes in production today: nothing ──────────
--
-- Production still connects as the table owner, which bypasses RLS
-- entirely, so every policy added here is inert until the cutover flips
-- DATABASE_URL. That is exactly why it is safe to land now and reckless to
-- land after: this is the work that has to be finished BEFORE step 5 of
-- TENANT-RLS-PLAN.md, not discovered during it.
--
-- ── Shapes used, and why ────────────────────────────────────
--
-- Parent walk, the pattern migrations 159/177/186 already use for tables
-- with no organization_id of their own:
--
--   USING (EXISTS (SELECT 1 FROM parent p
--                   WHERE p.id = child.parent_id
--                     AND p.organization_id::text = current_setting('app.org_id', true)))
--
-- Where the parent FK is NULLABLE the policy also admits NULL. Without
-- that, a row with no parent — a face check-in that matched nobody, a
-- system notification addressed to no user, a WebAuthn challenge issued
-- before the account exists — would be visible to no studio at all, which
-- is a second silent-data-loss bug introduced while fixing the first. Four
-- columns are nullable and are handled that way: face_checkin_logs.client_id,
-- trial_sessions.client_id, notifications.user_id, agent_audit_log.user_id,
-- webauthn_challenges.user_id.
--
-- Global reference data gets USING (true). These tables have no tenancy to
-- express — a shared anatomy/exercise library, the platform's own model
-- price list and plan-feature matrix, single-row counters. Today every
-- authenticated caller reads and writes them through the owner connection,
-- gated only by the application's role checks; USING (true) preserves that
-- exactly. Anything stricter would remove working functionality, which is
-- a behaviour change this migration is not entitled to make.
--
-- ── What this deliberately does NOT fix ─────────────────────
--
-- `system_settings` holds per-studio branch definitions (`branch_<uuid>`
-- keys) in a shared, org-less table. That is a genuine cross-tenant
-- exposure, it predates this migration, and it is already recorded as a
-- reviewed exception in tenantColumns.convention.test.js's KNOWN_GAPS.
-- Closing it means adding organization_id to system_settings and migrating
-- every branch key onto it — a data migration with real behaviour risk that
-- needs its own change and its own argument. Giving it USING (true) here
-- neither improves nor worsens that; it keeps today's behaviour while the
-- rest of the surface becomes enforceable. It stays on KNOWN_GAPS.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    RAISE NOTICE '188: app_tenant absent, skipping policy creation';
    RETURN;
  END IF;

  -- ── Parent walk: client_id → pt_clients (NOT NULL) ──────────────────
  DECLARE t TEXT;
  BEGIN
    FOREACH t IN ARRAY ARRAY[
      'body_metrics','weight_logs','churn_risk_log','face_descriptors',
      'holds_freezes','membership_actions','pt_client_renewals',
      'pt_client_subscriptions','trials','members','payments'
    ] LOOP
      IF to_regclass('public.'||quote_ident(t)) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON public.%1$I FOR ALL TO app_tenant
          USING (EXISTS (SELECT 1 FROM public.pt_clients c
                          WHERE c.id = %1$I.client_id
                            AND c.organization_id::text = current_setting('app.org_id', true)))
          WITH CHECK (EXISTS (SELECT 1 FROM public.pt_clients c
                          WHERE c.id = %1$I.client_id
                            AND c.organization_id::text = current_setting('app.org_id', true)))
      $f$, t);
    END LOOP;
  END;

  -- ── Parent walk: client_id → pt_clients (NULLABLE) ──────────────────
  DECLARE t TEXT;
  BEGIN
    FOREACH t IN ARRAY ARRAY['face_checkin_logs','trial_sessions'] LOOP
      IF to_regclass('public.'||quote_ident(t)) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON public.%1$I FOR ALL TO app_tenant
          USING (%1$I.client_id IS NULL OR EXISTS (SELECT 1 FROM public.pt_clients c
                          WHERE c.id = %1$I.client_id
                            AND c.organization_id::text = current_setting('app.org_id', true)))
          WITH CHECK (%1$I.client_id IS NULL OR EXISTS (SELECT 1 FROM public.pt_clients c
                          WHERE c.id = %1$I.client_id
                            AND c.organization_id::text = current_setting('app.org_id', true)))
      $f$, t);
    END LOOP;
  END;

  -- ── Parent walk: trainer_id → pt_trainers ───────────────────────────
  -- The money tables. Their tenant boundary has always run through the
  -- trainer, not the client — see the payouts/commissions section of
  -- e2e/tenant-isolation.api.spec.ts in the frontend repo.
  DECLARE t TEXT;
  BEGIN
    FOREACH t IN ARRAY ARRAY['pt_commissions','pt_payouts'] LOOP
      IF to_regclass('public.'||quote_ident(t)) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON public.%1$I FOR ALL TO app_tenant
          USING (EXISTS (SELECT 1 FROM public.pt_trainers tr
                          WHERE tr.id = %1$I.trainer_id
                            AND tr.organization_id::text = current_setting('app.org_id', true)))
          WITH CHECK (EXISTS (SELECT 1 FROM public.pt_trainers tr
                          WHERE tr.id = %1$I.trainer_id
                            AND tr.organization_id::text = current_setting('app.org_id', true)))
      $f$, t);
    END LOOP;
  END;

  -- ── Parent walk: user_id → users (NOT NULL) ─────────────────────────
  DECLARE t TEXT;
  BEGIN
    FOREACH t IN ARRAY ARRAY[
      'agent_tasks','ai_usage_log','ai_conversations','exercise_favorites',
      'exercise_recent_usage','google_calendar_events','google_calendar_tokens',
      'qr_tokens','refresh_tokens','user_profiles'
    ] LOOP
      IF to_regclass('public.'||quote_ident(t)) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON public.%1$I FOR ALL TO app_tenant
          USING (EXISTS (SELECT 1 FROM public.users u
                          WHERE u.id = %1$I.user_id
                            AND u.organization_id::text = current_setting('app.org_id', true)))
          WITH CHECK (EXISTS (SELECT 1 FROM public.users u
                          WHERE u.id = %1$I.user_id
                            AND u.organization_id::text = current_setting('app.org_id', true)))
      $f$, t);
    END LOOP;
  END;

  -- ── Parent walk: user_id → users (NULLABLE) ─────────────────────────
  -- A NULL user_id is a real state here, not a defect: a system-generated
  -- notification addressed to no one in particular, an audit line from a
  -- background task, a WebAuthn challenge minted before the account exists.
  DECLARE t TEXT;
  BEGIN
    FOREACH t IN ARRAY ARRAY['notifications','agent_audit_log','webauthn_challenges'] LOOP
      IF to_regclass('public.'||quote_ident(t)) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON public.%1$I FOR ALL TO app_tenant
          USING (%1$I.user_id IS NULL OR EXISTS (SELECT 1 FROM public.users u
                          WHERE u.id = %1$I.user_id
                            AND u.organization_id::text = current_setting('app.org_id', true)))
          WITH CHECK (%1$I.user_id IS NULL OR EXISTS (SELECT 1 FROM public.users u
                          WHERE u.id = %1$I.user_id
                            AND u.organization_id::text = current_setting('app.org_id', true)))
      $f$, t);
    END LOOP;
  END;

  -- ── Parent walk: one hop, table-specific parent ─────────────────────
  -- (child table, child fk column, parent table) — each parent below is
  -- itself organization_id-scoped and already policied, verified before
  -- writing this, so the walk terminates somewhere real rather than at
  -- another unprotected table.
  DECLARE m TEXT[];
  BEGIN
    FOREACH m SLICE 1 IN ARRAY ARRAY[
      ['invoice_items','invoice_id','invoices'],
      ['workout_exercises','workout_plan_id','workout_plans'],
      ['workout_template_exercises','workout_template_id','workout_templates'],
      ['training_program_phases','program_id','training_programs'],
      ['training_program_weeks','program_id','training_programs'],
      ['diet_plan_meals','diet_template_id','diet_templates'],
      ['exercise_versions','exercise_id','exercises']
      -- exercise_performances is NOT here: its session_id is uuid while
      -- workout_sessions.id is text, so the comparison needs an explicit
      -- cast and is written out below.
    ] LOOP
      IF to_regclass('public.'||quote_ident(m[1])) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', m[1]);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', m[1]);
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON public.%1$I FOR ALL TO app_tenant
          USING (EXISTS (SELECT 1 FROM public.%3$I p
                          WHERE p.id = %1$I.%2$I
                            AND p.organization_id::text = current_setting('app.org_id', true)))
          WITH CHECK (EXISTS (SELECT 1 FROM public.%3$I p
                          WHERE p.id = %1$I.%2$I
                            AND p.organization_id::text = current_setting('app.org_id', true)))
      $f$, m[1], m[2], m[3]);
    END LOOP;
  END;

  -- ── exercise_performances → workout_sessions, across a type seam ────
  --
  -- `exercise_performances.session_id` is uuid; `workout_sessions.id` is
  -- text. Postgres has no implicit uuid = text, so the generated policy
  -- above fails outright with "operator does not exist: text = uuid" —
  -- which is how this seam was found. The two tables therefore cannot have
  -- carried a foreign key between them either, and nothing has been
  -- enforcing that a session_id points at a session that exists.
  --
  -- The cast goes on the CHILD (uuid → text), not the parent, so the
  -- parent's primary-key index is still usable inside the subquery; the
  -- other direction would force a sequential scan of workout_sessions on
  -- every row check. Recorded here rather than silently normalised: making
  -- the column types agree is a schema change with its own backfill and
  -- its own risk, and belongs in its own migration.
  IF to_regclass('public.exercise_performances') IS NOT NULL THEN
    ALTER TABLE public.exercise_performances ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON public.exercise_performances;
    CREATE POLICY tenant_isolation ON public.exercise_performances FOR ALL TO app_tenant
      USING (EXISTS (SELECT 1 FROM public.workout_sessions p
                      WHERE p.id = exercise_performances.session_id::text
                        AND p.organization_id::text = current_setting('app.org_id', true)))
      WITH CHECK (EXISTS (SELECT 1 FROM public.workout_sessions p
                      WHERE p.id = exercise_performances.session_id::text
                        AND p.organization_id::text = current_setting('app.org_id', true)));
  END IF;

  -- ── Parent walk: two hops ───────────────────────────────────────────
  -- Written out rather than leaning on the intermediate table's own RLS.
  -- Nested policy evaluation would in fact filter these correctly, but it
  -- makes each policy's correctness depend on another policy staying
  -- correct — and 158 and 185 are both cases of a sweep quietly rewriting
  -- a policy somebody else was relying on.
  DECLARE m TEXT[];
  BEGIN
    FOREACH m SLICE 1 IN ARRAY ARRAY[
      -- child, child fk, mid table, mid fk, grandparent, cast on mid fk
      --
      -- The last element exists only because of the uuid/text seam
      -- described above: exercise_performances.session_id is uuid and
      -- workout_sessions.id is text, so that one join needs the cast and
      -- the others must not have it.
      ['set_performances','exercise_performance_id','exercise_performances','session_id','workout_sessions','::text'],
      ['cardio_performances','exercise_performance_id','exercise_performances','session_id','workout_sessions','::text'],
      ['biometric_attendance','member_id','members','client_id','pt_clients',''],
      ['webauthn_credentials','member_id','members','client_id','pt_clients',''],
      ['ai_messages','conversation_id','ai_conversations','user_id','users','']
    ] LOOP
      IF to_regclass('public.'||quote_ident(m[1])) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', m[1]);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', m[1]);
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON public.%1$I FOR ALL TO app_tenant
          USING (EXISTS (SELECT 1 FROM public.%3$I mid JOIN public.%5$I gp ON gp.id = mid.%4$I%6$s
                          WHERE mid.id = %1$I.%2$I
                            AND gp.organization_id::text = current_setting('app.org_id', true)))
          WITH CHECK (EXISTS (SELECT 1 FROM public.%3$I mid JOIN public.%5$I gp ON gp.id = mid.%4$I%6$s
                          WHERE mid.id = %1$I.%2$I
                            AND gp.organization_id::text = current_setting('app.org_id', true)))
      $f$, m[1], m[2], m[3], m[4], m[5], m[6]);
    END LOOP;
  END;

  -- ── Global / shared reference data ──────────────────────────────────
  -- No tenancy to express. A shared anatomy and exercise-classification
  -- library every studio draws from; the platform's own model price list
  -- and plan-feature matrix; single-row counters; the org-less settings and
  -- flag tables. USING (true) reproduces exactly what these tables do today
  -- on the owner connection — it is not a widening.
  DECLARE t TEXT;
  BEGIN
    FOREACH t IN ARRAY ARRAY[
      'muscles','exercise_categories','equipment_types','exercise_muscles',
      'exercise_relations','ai_model_rates','plan_features','ai_provider_settings',
      'pt_plans','branches','receipt_counter','storage_accounting_meta',
      'feature_flags','system_settings','audit_log'
    ] LOOP
      IF to_regclass('public.'||quote_ident(t)) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_shared_read ON public.%I', t);
      EXECUTE format($f$
        CREATE POLICY tenant_shared_read ON public.%1$I FOR ALL TO app_tenant
          USING (true) WITH CHECK (true)
      $f$, t);
    END LOOP;
  END;
END $$;

-- ── Verification ─────────────────────────────────────────────
-- Fails the migration rather than deploying a half-closed gap. Only the
-- tables this migration names are checked: a table added later with no
-- policy is the convention test's job (architecture.rlsShape), not this
-- file's, and hard-coding a whole-schema assertion here would turn every
-- future unrelated migration into this one's problem.
DO $$
DECLARE
  t TEXT;
  missing TEXT[] := ARRAY[]::TEXT[];
  expected TEXT[] := ARRAY[
    'body_metrics','weight_logs','churn_risk_log','face_descriptors','holds_freezes',
    'membership_actions','pt_client_renewals','pt_client_subscriptions','trials','members',
    'payments','face_checkin_logs','trial_sessions','pt_commissions','pt_payouts',
    'agent_tasks','ai_usage_log','ai_conversations','exercise_favorites','exercise_recent_usage',
    'google_calendar_events','google_calendar_tokens','qr_tokens','refresh_tokens','user_profiles',
    'notifications','agent_audit_log','webauthn_challenges','invoice_items','workout_exercises',
    'workout_template_exercises','training_program_phases','training_program_weeks','diet_plan_meals',
    'exercise_versions','exercise_performances','set_performances','cardio_performances',
    'biometric_attendance','webauthn_credentials','ai_messages','muscles','exercise_categories',
    'equipment_types','exercise_muscles','exercise_relations','ai_model_rates','plan_features',
    'ai_provider_settings','pt_plans','branches','receipt_counter','storage_accounting_meta',
    'feature_flags','system_settings','audit_log'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    RAISE NOTICE '188: app_tenant absent, skipping verification';
    RETURN;
  END IF;
  FOREACH t IN ARRAY expected LOOP
    IF to_regclass('public.'||quote_ident(t)) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname='public' AND p.tablename=t
                      AND 'app_tenant' = ANY(p.roles)) THEN
      missing := array_append(missing, t);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '188: still no app_tenant policy on: %', array_to_string(missing, ', ');
  END IF;
  RAISE NOTICE '188: % tables now carry an app_tenant policy', array_length(expected, 1);
END $$;

-- PostgREST roles never reach any of these.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'body_metrics','weight_logs','churn_risk_log','face_descriptors','holds_freezes',
    'membership_actions','pt_client_renewals','pt_client_subscriptions','trials','members',
    'payments','face_checkin_logs','trial_sessions','pt_commissions','pt_payouts',
    'agent_tasks','ai_usage_log','ai_conversations','exercise_favorites','exercise_recent_usage',
    'google_calendar_events','google_calendar_tokens','qr_tokens','refresh_tokens','user_profiles',
    'notifications','agent_audit_log','webauthn_challenges','invoice_items','workout_exercises',
    'workout_template_exercises','training_program_phases','training_program_weeks','diet_plan_meals',
    'exercise_versions','exercise_performances','set_performances','cardio_performances',
    'biometric_attendance','webauthn_credentials','ai_messages','muscles','exercise_categories',
    'equipment_types','exercise_muscles','exercise_relations','ai_model_rates','plan_features',
    'ai_provider_settings','pt_plans','branches','receipt_counter','storage_accounting_meta',
    'feature_flags','system_settings','audit_log'
  ] LOOP
    IF to_regclass('public.'||quote_ident(t)) IS NULL THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
