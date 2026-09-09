-- ============================================================
-- 189_platform_tenant_seam.sql
--
-- Two places where the platform and tenant planes are wired into each
-- other wrongly, found while closing 188's policy gap. Both are latent
-- today (the app connects as the owner, which bypasses RLS) and both bite
-- the moment DATABASE_URL points at app_tenant.
--
-- ── 1. support_ticket_messages is unreachable by the studio that owns it
--
-- routes/support.js is the TENANT support surface: it scopes every query
-- with `organization_id = $2::uuid`, reads the message thread, and INSERTs
-- the studio's replies. `support_tickets` carries organization_id and has a
-- correct tenant policy. `support_ticket_messages` had no app_tenant policy
-- at all — so after the cutover a studio would open its own ticket, see the
-- subject, and find the conversation empty, with no way to reply. Not an
-- error; zero rows.
--
-- The walk is ticket_id → support_tickets.organization_id (both uuid, no
-- cast needed), AND `is_internal = FALSE`.
--
-- That second half is the part worth being deliberate about. `is_internal`
-- marks the operator's private notes on a ticket, and lib/support.js keeps
-- them from the studio with `WHERE ticket_id = $1 AND is_internal = FALSE`
-- in TENANT_MESSAGE_SQL. A policy that only checked the org would make the
-- database hand over internal notes the moment any query forgot that WHERE
-- clause — which is exactly the failure RLS is supposed to backstop. The
-- operator's own reads and writes are unaffected: they run over the owner
-- connection, which no policy constrains.
--
-- ── 2. app_tenant could REWRITE the platform's payment details
--
-- `platform_payment_settings` is the singleton row holding 619's own UPI
-- id, merchant name and payment instructions — where every studio is told
-- to send its subscription money. It carried:
--
--     CREATE POLICY tenant_isolation ... TO app_tenant
--       FOR ALL USING (true) WITH CHECK (true)
--
-- FOR ALL, not FOR SELECT. As a database-level statement that is: any
-- studio may change the account every other studio pays into. Today the
-- only thing preventing that is the application's own role check on the
-- platform route — which is precisely the layer RLS exists to be
-- independent of. The whole argument for the tenant role is that a missing
-- authorization check must not be sufficient to reach another plane's data.
--
-- The tenant genuinely needs to READ it: lib/subscriptionCheckout.js's
-- getPlatformSettings() runs inside openCheckout, a tenant flow — a studio
-- opening a subscription checkout has to learn where to pay. It never needs
-- to write it. savePlatformSettings() is called from exactly one place,
-- modules/platform/super-admin/subscriptions.js, which is a platform route.
--
-- Narrowing this to SELECT is only safe because of the change that landed
-- with it: requirePlatformOwner now wraps the whole handler in
-- runAsPlatform, so every platform-console query — including this write —
-- runs on the owner connection regardless of whether the operator has a
-- studio pinned in the org-switcher. Before that, an operator with x-org-id
-- set would have hit app_tenant here and this narrowing would have broken
-- saving payment settings for them. The order matters; the two go together.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    RAISE NOTICE '189: app_tenant absent, skipping';
    RETURN;
  END IF;

  -- ── 1. support_ticket_messages ──────────────────────────────────────
  IF to_regclass('public.support_ticket_messages') IS NOT NULL THEN
    ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON public.support_ticket_messages;
    CREATE POLICY tenant_isolation ON public.support_ticket_messages FOR ALL TO app_tenant
      USING (
        support_ticket_messages.is_internal = FALSE
        AND EXISTS (SELECT 1 FROM public.support_tickets t
                     WHERE t.id = support_ticket_messages.ticket_id
                       AND t.organization_id::text = current_setting('app.org_id', true)))
      WITH CHECK (
        support_ticket_messages.is_internal = FALSE
        AND EXISTS (SELECT 1 FROM public.support_tickets t
                     WHERE t.id = support_ticket_messages.ticket_id
                       AND t.organization_id::text = current_setting('app.org_id', true)));
    RAISE NOTICE '189: support_ticket_messages scoped to its ticket''s studio, internal notes excluded';
  END IF;

  -- ── 2. platform_payment_settings: read, never write ─────────────────
  IF to_regclass('public.platform_payment_settings') IS NOT NULL THEN
    ALTER TABLE public.platform_payment_settings ENABLE ROW LEVEL SECURITY;
    -- The old policy was named tenant_isolation, which it was not doing.
    DROP POLICY IF EXISTS tenant_isolation ON public.platform_payment_settings;
    DROP POLICY IF EXISTS tenant_read_payee ON public.platform_payment_settings;
    CREATE POLICY tenant_read_payee ON public.platform_payment_settings FOR SELECT TO app_tenant
      USING (true);

    -- Belt and braces, at the privilege layer rather than the policy layer.
    -- 157 granted app_tenant blanket DML on every table in `public`, so the
    -- grant is still there even though no policy would now admit a write.
    -- Two independent "no" answers, because the failure being defended
    -- against is somebody adding a permissive policy later without noticing
    -- what this table is.
    REVOKE INSERT, UPDATE, DELETE ON public.platform_payment_settings FROM app_tenant;
    RAISE NOTICE '189: platform_payment_settings is now read-only for app_tenant';
  END IF;
END $$;

-- ── Verification ─────────────────────────────────────────────
DO $$
DECLARE
  n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN RETURN; END IF;

  IF to_regclass('public.support_ticket_messages') IS NOT NULL THEN
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname='public' AND tablename='support_ticket_messages' AND 'app_tenant' = ANY(roles);
    IF n = 0 THEN
      RAISE EXCEPTION '189: support_ticket_messages still has no app_tenant policy';
    END IF;
  END IF;

  IF to_regclass('public.platform_payment_settings') IS NOT NULL THEN
    -- The point of the change: no policy may leave app_tenant able to write
    -- this table. cmd is 'ALL' for FOR ALL, 'SELECT' for FOR SELECT.
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname='public' AND tablename='platform_payment_settings'
       AND 'app_tenant' = ANY(roles) AND cmd <> 'SELECT';
    IF n > 0 THEN
      RAISE EXCEPTION '189: app_tenant can still write platform_payment_settings';
    END IF;
  END IF;
END $$;
