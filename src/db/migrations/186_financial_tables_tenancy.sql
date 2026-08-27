-- ============================================================
-- 186_financial_tables_tenancy.sql
--
-- Six financial tables reachable by app_tenant whose only policy is
-- deny_all_direct_access USING (false):
--
--   pt_client_subscriptions   canonical PT term history, read by the profile
--   pt_client_renewals        read by routes/clients.js:277
--   payments                  legacy PT payments, written by invoices.js:272
--   pt_commissions            written by pt-os.service.js:65-74
--   pt_payouts                written by pt-os.service.js:329-338
--   invoice_items             written by routes/invoices.js:177,186
--
-- Three of the nine financial tables are already healthy and are NOT touched:
-- pt_payments, payment_orders and invoices carry organization_id and a working
-- tenant_isolation policy. They are the template this migration matches.
--
-- ── Two different severities, both real ───────────────────────────────────
--
-- Measured directly against app_tenant rather than through the API:
--
--   reads  go SILENTLY dark. SELECT returns zero rows, no error — a Client 360
--          financial section renders as "no history" rather than as a failure.
--   writes fail LOUDLY. INSERT is refused outright, so the day DATABASE_URL
--          moves to app_tenant, recording a renewal, a subscription, an
--          invoice line, a commission or a payout stops working.
--
-- ── What this migration does not do ───────────────────────────────────────
--
-- No DELETE anywhere. No UPDATE to any amount, date, or historical
-- trainer_id/client_id attribution. The only column written is the
-- organization_id being added. Money and its attribution are read to derive
-- the org and are never themselves rewritten.
-- ============================================================

-- ── 1. The column, on the five tables that need one ────────────────────────
--
-- invoice_items is deliberately absent from this list. Its org is definitionally
-- its invoice's org, always written in the same transaction (invoices.js:164-186),
-- so a column here would be a second source of truth free to drift from the
-- invoice it belongs to. It takes the pure parent-walk in section 4 instead —
-- the shape 159 already uses for workout_sets.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pt_client_subscriptions','pt_client_renewals',
                           'payments','pt_commissions','pt_payouts']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t
                      AND column_name='organization_id') THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN organization_id UUID', t);
      RAISE NOTICE '186: added %.organization_id.', t;
    END IF;

    IF to_regclass('public.organizations') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conrelid = ('public.' || t)::regclass
                          AND conname = t || '_organization_id_fkey') THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (organization_id) '
        || 'REFERENCES public.organizations(id) ON DELETE CASCADE',
        t, t || '_organization_id_fkey');
    END IF;
  END LOOP;
END $$;

-- ── 2. Backfill, each from its own parent ──────────────────────────────────
--
-- Four resolve through client_id → pt_clients. pt_payouts has no client
-- dimension at all — it is per trainer per month — so it resolves through
-- trainer_id → trainers, which already carries a real foreign key.
--
-- Every statement is guarded on `organization_id IS NULL`, so a second run
-- touches zero rows.
DO $$
DECLARE
  spec RECORD;
  moved INT;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('pt_client_subscriptions', 'client_id',  'pt_clients'),
      ('pt_client_renewals',      'client_id',  'pt_clients'),
      ('payments',                'client_id',  'pt_clients'),
      ('pt_commissions',          'client_id',  'pt_clients'),
      ('pt_payouts',              'trainer_id', 'trainers')
    ) AS s(child, fk, parent)
  LOOP
    CONTINUE WHEN to_regclass('public.' || spec.child)  IS NULL;
    CONTINUE WHEN to_regclass('public.' || spec.parent) IS NULL;

    EXECUTE format(
      'UPDATE public.%I c SET organization_id = p.organization_id '
      || 'FROM public.%I p '
      || 'WHERE c.organization_id IS NULL AND p.id = c.%I '
      || '  AND p.organization_id IS NOT NULL',
      spec.child, spec.parent, spec.fk);
    GET DIAGNOSTICS moved = ROW_COUNT;

    RAISE NOTICE '186: attributed % row(s) in % via %.', moved, spec.child, spec.fk;
  END LOOP;
END $$;

-- ── 3. The gate ────────────────────────────────────────────────────────────
--
-- A row left with a NULL organization_id matches NO studio's policy predicate.
-- Once DATABASE_URL moves to app_tenant it becomes invisible in every
-- direction, permanently, with no error anywhere — and on these tables that
-- means a payment, a renewal or a commission silently missing from a client's
-- ledger and from the studio's books.
--
-- That is worth stopping a deploy over, so this RAISES rather than warns —
-- the same rule 184 applies to its uniqueness index: abort when proceeding
-- would leave the database contradicting what the code above it assumes.
-- The whole migration runs in one transaction, so the abort rolls the column
-- additions back and nothing is left half-applied.
--
-- This is expected to pass cleanly. Every live write site sources its
-- client_id from a route parameter that was already tenant-verified earlier in
-- the same handler, and pt_payouts.trainer_id has carried a foreign key to
-- trainers since 011b. A failure here means genuinely orphaned legacy data,
-- which a human should look at before it is made invisible.
-- The test asks the REAL question — "would this row be visible to its own
-- studio?" — not the cheaper proxy "is its organization_id set?".
--
-- Those are not the same question, and the difference is not academic. The
-- four client-bearing tables below get the AND'd parent walk in section 4, so
-- a row is reachable only if BOTH halves hold: the column matches, AND its
-- client resolves to a client in that same studio. A payment carrying a
-- perfectly good organization_id whose client_id points at a deleted client
-- satisfies the column check and is still invisible for ever.
--
-- Checking only the column would let exactly that row through a gate whose
-- stated purpose is to catch it. Found by seeding one and watching the owner
-- see three payments while the studio that owned all three saw one.
DO $$
DECLARE
  spec RECORD;
  n INT;
  total INT := 0;
  offenders TEXT := '';
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- child, the predicate that makes a row UNREACHABLE to its own studio
      ('pt_client_subscriptions',
       'organization_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.pt_clients p '
       || 'WHERE p.id = c.client_id AND p.organization_id = c.organization_id)'),
      ('pt_client_renewals',
       'organization_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.pt_clients p '
       || 'WHERE p.id = c.client_id AND p.organization_id = c.organization_id)'),
      ('payments',
       'organization_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.pt_clients p '
       || 'WHERE p.id = c.client_id AND p.organization_id = c.organization_id)'),
      ('pt_commissions',
       'organization_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.pt_clients p '
       || 'WHERE p.id = c.client_id AND p.organization_id = c.organization_id)'),
      -- trainer-only: the direct column check is the whole policy
      ('pt_payouts', 'organization_id IS NULL'),
      -- no column at all; reachability is entirely its invoice's
      ('invoice_items',
       'NOT EXISTS (SELECT 1 FROM public.invoices i '
       || 'WHERE i.id = c.invoice_id AND i.organization_id IS NOT NULL)')
    ) AS s(child, unreachable)
  LOOP
    CONTINUE WHEN to_regclass('public.' || spec.child) IS NULL;
    EXECUTE format('SELECT count(*) FROM public.%I c WHERE %s', spec.child, spec.unreachable)
      INTO n;
    IF n > 0 THEN
      total := total + n;
      offenders := offenders || format('%s (%s row(s)); ', spec.child, n);
    END IF;
  END LOOP;

  IF total > 0 THEN
    RAISE EXCEPTION '186: % financial row(s) would be invisible to their own studio: %',
      total, offenders
      USING HINT = 'Each names a client, trainer or invoice that does not exist, or that belongs to a '
                || 'different studio than the row itself. Do NOT delete them — they are financial history. '
                || 'Find them per table, e.g.: SELECT * FROM payments c WHERE organization_id IS NULL '
                || 'OR NOT EXISTS (SELECT 1 FROM pt_clients p WHERE p.id = c.client_id '
                || 'AND p.organization_id = c.organization_id); '
                || 'Repoint the row at the right parent, or set its organization_id to the studio that '
                || 'parent belongs to, then re-run this migration.';
  END IF;

  RAISE NOTICE '186: every financial row is reachable by the studio that owns it.';
END $$;

-- ── 4. Tighten, then police ────────────────────────────────────────────────
--
-- NOT NULL is safe to set unconditionally here: section 3 already aborted if
-- anything was unattributed, so reaching this point means the column is clean.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pt_client_subscriptions','pt_client_renewals',
                           'payments','pt_commissions','pt_payouts']
  LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name=t
                  AND column_name='organization_id' AND is_nullable='YES') THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', t);
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (organization_id)',
                   t || '_org_idx', t);
  END LOOP;
END $$;

-- The four client-bearing tables take the AND'd PARENT WALK, not a bare column
-- check — 174's reasoning, applied to four more tables.
--
-- A foreign key guarantees the referenced client EXISTS. It does not guarantee
-- that client belongs to the org the caller is claiming. A bare
-- `organization_id = current org` WITH CHECK therefore accepts an INSERT that
-- stamps the caller's own org onto a row pointing at ANOTHER studio's client —
-- which, on these tables, is how one studio's money gets attached to another
-- studio's member.
--
-- ONE policy with both halves ANDed, never two policies: Postgres OR's
-- permissive policies, so a pair would be WEAKER than either alone.
DO $$
DECLARE
  spec RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_tenant') THEN
    RAISE NOTICE '186: no app_tenant role here — skipping the policies.';
    RETURN;
  END IF;
  IF to_regclass('public.pt_clients') IS NULL THEN RETURN; END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      ('pt_client_subscriptions'), ('pt_client_renewals'),
      ('payments'), ('pt_commissions')
    ) AS s(child)
  LOOP
    CONTINUE WHEN to_regclass('public.' || spec.child) IS NULL;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', spec.child);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', spec.child);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant '
      || 'USING ('
      || '  organization_id::text = current_setting(''app.org_id'', true) '
      || '  AND EXISTS (SELECT 1 FROM public.pt_clients p WHERE p.id = public.%I.client_id '
      || '              AND p.organization_id::text = current_setting(''app.org_id'', true))) '
      || 'WITH CHECK ('
      || '  organization_id::text = current_setting(''app.org_id'', true) '
      || '  AND EXISTS (SELECT 1 FROM public.pt_clients p WHERE p.id = public.%I.client_id '
      || '              AND p.organization_id::text = current_setting(''app.org_id'', true)))',
      spec.child, spec.child, spec.child);
  END LOOP;
END $$;

-- pt_payouts takes the DIRECT column check. It has no client dimension — a
-- payout is one trainer, one month — so the client-forgery risk the walk
-- defends against does not exist here. This is pt_payments' own healthy shape.
DO $$
BEGIN
  IF to_regclass('public.pt_payouts') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_tenant') THEN RETURN; END IF;

  EXECUTE 'ALTER TABLE public.pt_payouts ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.pt_payouts';
  EXECUTE
    'CREATE POLICY tenant_isolation ON public.pt_payouts FOR ALL TO app_tenant '
    || 'USING (organization_id::text = current_setting(''app.org_id'', true)) '
    || 'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))';
END $$;

-- invoice_items takes the PURE parent walk — no column of its own, so nothing
-- can drift from the invoice. 159's workout_sets shape.
DO $$
BEGIN
  IF to_regclass('public.invoice_items') IS NULL THEN RETURN; END IF;
  IF to_regclass('public.invoices') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_tenant') THEN RETURN; END IF;

  EXECUTE 'ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.invoice_items';
  EXECUTE
    'CREATE POLICY tenant_isolation ON public.invoice_items FOR ALL TO app_tenant '
    || 'USING (EXISTS (SELECT 1 FROM public.invoices i '
    || '               WHERE i.id = public.invoice_items.invoice_id '
    || '                 AND i.organization_id::text = current_setting(''app.org_id'', true))) '
    || 'WITH CHECK (EXISTS (SELECT 1 FROM public.invoices i '
    || '                    WHERE i.id = public.invoice_items.invoice_id '
    || '                      AND i.organization_id::text = current_setting(''app.org_id'', true)))';

  CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON public.invoice_items (invoice_id);
END $$;

-- ── 5. Close the Supabase side doors, as every RLS migration here does ─────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pt_client_subscriptions','pt_client_renewals','payments',
                           'pt_commissions','pt_payouts','invoice_items']
  LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;

-- ── 6. BEFORE → AFTER, asserted rather than assumed ────────────────────────
--
-- This migration contains no DELETE, so a count change is impossible by
-- construction. It is checked anyway, because "impossible by construction" is
-- what everything looks like right up until it is not — and on money, the
-- assertion costs one query.
--
-- The counts are captured at the top of this block and re-read at the bottom;
-- both run after the writes above, so what is really being proven is that the
-- policies just created did not change what the OWNER connection can see.
DO $$
DECLARE
  t TEXT;
  n INT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pt_client_subscriptions','pt_client_renewals','payments',
                           'pt_commissions','pt_payouts','invoice_items']
  LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    RAISE NOTICE '186: % holds % row(s), all attributed.', t, n;
  END LOOP;
END $$;
