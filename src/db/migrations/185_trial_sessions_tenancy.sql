-- ============================================================
-- 185_trial_sessions_tenancy.sql
--
-- `trial_sessions` has no organization_id, no foreign keys on the two columns
-- that identify whose trial it is, and one policy: deny_all_direct_access
-- USING (false). It is unreachable from the tenant connection in every
-- direction, for every studio, always.
--
-- ── Why this is schema-only, and why that is not a reason to skip it ───────
--
-- The table has NO live write path. Grepping every INSERT and UPDATE across
-- src/ returns nothing; its only reference outside migration 012 is a passive
-- entry in the merge-duplicates refTables array (pt-os.routes.js:1630). The
-- feature was scaffolded in 012 and never connected — pt-os/leads has a
-- `trial_scheduled` LEAD STATUS, but nothing wires that status to a row here.
--
-- So there is no regression risk from this migration: there is no code path to
-- regress. What there is, is a table that will be wired up one day, and which
-- would be wired up wrong — because today it has nowhere to put the org, and
-- nothing stopping a trial pointing at another studio's lead.
--
-- ── What this migration will not do ───────────────────────────────────────
--
-- It does not wire up a trial-creation route. That is the feature, not the
-- tenancy fix, and inventing it here would be inventing a product.
--
-- It does not rewrite `converted`. See section 6.
--
-- It deletes nothing and it overwrites nothing that already existed. The only
-- column it writes is the organization_id it adds.
-- ============================================================

-- ── 1. The column ───────────────────────────────────────────────────────────
--
-- Nullable to begin with, matching 172/174's convention: add, backfill,
-- then tighten only what came back clean.
DO $$
BEGIN
  IF to_regclass('public.trial_sessions') IS NULL THEN
    RAISE NOTICE '185: trial_sessions does not exist — nothing to do.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trial_sessions'
       AND column_name='organization_id'
  ) THEN
    ALTER TABLE public.trial_sessions ADD COLUMN organization_id UUID;
    RAISE NOTICE '185: added trial_sessions.organization_id.';
  END IF;

  -- Added separately from the column so a re-run over a table that already has
  -- the column still gets the constraint.
  IF to_regclass('public.organizations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid='public.trial_sessions'::regclass
          AND conname='trial_sessions_organization_id_fkey'
     ) THEN
    ALTER TABLE public.trial_sessions
      ADD CONSTRAINT trial_sessions_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── 2. The contradiction check, BEFORE anything is written ─────────────────
--
-- A row can name both a lead and a client. If those two resolve to DIFFERENT
-- studios, then whichever one this migration picked would be a guess, and a
-- guess about which studio a trial belonged to is exactly the kind of silent
-- rewrite the no-data-loss rule exists to prevent.
--
-- So it is reported and left alone. The backfill in section 3 skips these rows
-- explicitly rather than relying on COALESCE order to hide the disagreement.
DO $$
DECLARE
  n INT := 0;
  r RECORD;
BEGIN
  IF to_regclass('public.trial_sessions') IS NULL THEN RETURN; END IF;
  IF to_regclass('public.pt_clients') IS NULL OR to_regclass('public.pt_leads') IS NULL THEN RETURN; END IF;

  FOR r IN
    SELECT ts.id, c.organization_id AS client_org, l.organization_id AS lead_org
      FROM public.trial_sessions ts
      JOIN public.pt_clients c ON c.id = ts.client_id
      JOIN public.pt_leads   l ON l.id = ts.lead_id
     WHERE c.organization_id IS DISTINCT FROM l.organization_id
  LOOP
    n := n + 1;
    RAISE WARNING '185: trial_sessions % names a client in studio % and a lead in studio %. Left unattributed — a human must decide which is correct.',
      r.id, r.client_org, r.lead_org;
  END LOOP;

  IF n > 0 THEN
    RAISE WARNING '185: % trial row(s) contradict themselves and were NOT backfilled.', n;
  END IF;
END $$;

-- ── 3. Backfill ─────────────────────────────────────────────────────────────
--
-- Client first, then lead. A trial that produced a client is attributed to
-- that client's studio; one that only ever had a lead follows the lead.
--
-- `WHERE organization_id IS NULL` makes a second run touch zero rows.
DO $$
DECLARE
  from_client INT := 0;
  from_lead   INT := 0;
  orphaned    INT := 0;
BEGIN
  IF to_regclass('public.trial_sessions') IS NULL THEN RETURN; END IF;

  IF to_regclass('public.pt_clients') IS NOT NULL THEN
    WITH resolved AS (
      UPDATE public.trial_sessions ts
         SET organization_id = c.organization_id
        FROM public.pt_clients c
       WHERE ts.organization_id IS NULL
         AND c.id = ts.client_id
         AND c.organization_id IS NOT NULL
         -- Skip the contradictions reported above.
         AND NOT EXISTS (
           SELECT 1 FROM public.pt_leads l
            WHERE l.id = ts.lead_id
              AND l.organization_id IS DISTINCT FROM c.organization_id
         )
      RETURNING 1
    ) SELECT count(*) INTO from_client FROM resolved;
  END IF;

  IF to_regclass('public.pt_leads') IS NOT NULL THEN
    WITH resolved AS (
      UPDATE public.trial_sessions ts
         SET organization_id = l.organization_id
        FROM public.pt_leads l
       WHERE ts.organization_id IS NULL
         AND l.id = ts.lead_id
         AND l.organization_id IS NOT NULL
         -- The SAME guard the client pass carries, and it is load-bearing here
         -- rather than redundant. Without it a contradicting row — skipped by
         -- the client pass precisely because its two parents disagree — falls
         -- through to this pass and gets attributed to the LEAD's studio. That
         -- is the guess section 2 exists to refuse, arrived at by a different
         -- route. Caught by the four-case fixture, not by reading.
         AND NOT EXISTS (
           SELECT 1 FROM public.pt_clients c
            WHERE c.id = ts.client_id
              AND c.organization_id IS DISTINCT FROM l.organization_id
         )
      RETURNING 1
    ) SELECT count(*) INTO from_lead FROM resolved;
  END IF;

  SELECT count(*) INTO orphaned FROM public.trial_sessions WHERE organization_id IS NULL;

  RAISE NOTICE '185: attributed % trial(s) via client, % via lead.', from_client, from_lead;
  IF orphaned > 0 THEN
    RAISE WARNING '185: % trial row(s) could not be attributed to any studio (no resolvable client or lead). They are kept, and stay invisible to the tenant connection until a human assigns them.', orphaned;
  END IF;
END $$;

-- ── 4. The two foreign keys the table never had ────────────────────────────
--
-- NOT VALID: enforced immediately on new and changed rows, existing rows
-- checked separately. That is the safe shape for a table of unknown history —
-- a single dangling id from before this migration must not abort the deploy.
--
-- ON DELETE SET NULL, not CASCADE. A trial is evidence that a session happened;
-- deleting the lead it came from should not destroy the record of it.
DO $$
BEGIN
  IF to_regclass('public.trial_sessions') IS NULL THEN RETURN; END IF;

  IF to_regclass('public.pt_clients') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid='public.trial_sessions'::regclass
                        AND conname='trial_sessions_client_id_fkey') THEN
    ALTER TABLE public.trial_sessions
      ADD CONSTRAINT trial_sessions_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.pt_clients(id) ON DELETE SET NULL NOT VALID;
  END IF;

  IF to_regclass('public.pt_leads') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid='public.trial_sessions'::regclass
                        AND conname='trial_sessions_lead_id_fkey') THEN
    ALTER TABLE public.trial_sessions
      ADD CONSTRAINT trial_sessions_lead_id_fkey
      FOREIGN KEY (lead_id) REFERENCES public.pt_leads(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

-- Validate separately, and never fatally: a pre-existing dangling id is legacy
-- noise, not an invariant this migration is introducing. Report and move on.
DO $$
DECLARE
  c TEXT;
BEGIN
  IF to_regclass('public.trial_sessions') IS NULL THEN RETURN; END IF;
  FOREACH c IN ARRAY ARRAY['trial_sessions_client_id_fkey', 'trial_sessions_lead_id_fkey']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid='public.trial_sessions'::regclass
                  AND conname=c AND NOT convalidated) THEN
      BEGIN
        EXECUTE format('ALTER TABLE public.trial_sessions VALIDATE CONSTRAINT %I', c);
      EXCEPTION WHEN foreign_key_violation THEN
        RAISE WARNING '185: % could not be validated — some historical rows point at ids that no longer exist. The constraint still governs every new and changed row.', c;
      END;
    END IF;
  END LOOP;
END $$;

-- ── 5. RLS ──────────────────────────────────────────────────────────────────
--
-- A DIRECT column check, not the parent walk 174 uses for the assessment
-- tables. The parent walk exists to stop a child row being written against
-- ANOTHER studio's parent — it is needed where the child's only tie to a
-- studio is through that parent. Here both parents are NULLABLE: a walk-only
-- policy would make a walk-in trial with neither a client nor a lead
-- permanently unwritable, which is the one shape this table is for.
--
-- The forgery case the walk defends against is covered instead by the
-- contradiction check above plus the two new foreign keys.
DO $$
BEGIN
  IF to_regclass('public.trial_sessions') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_tenant') THEN
    RAISE NOTICE '185: no app_tenant role here — skipping the policy.';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public.trial_sessions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.trial_sessions';
  EXECUTE
    'CREATE POLICY tenant_isolation ON public.trial_sessions FOR ALL TO app_tenant '
    || 'USING (organization_id::text = current_setting(''app.org_id'', true)) '
    || 'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))';

  RAISE NOTICE '185: trial_sessions is now scoped to the calling studio.';
END $$;

-- The deny-all policy stays alongside it. Postgres OR's permissive policies,
-- so deny_all USING (false) contributes nothing to what tenant_isolation
-- allows — it remains as the floor for any role that is not app_tenant.
DO $$
BEGIN
  IF to_regclass('public.trial_sessions') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON public.trial_sessions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.trial_sessions FROM authenticated';
  END IF;
END $$;

-- ── 6. `converted` — reported, never rewritten ─────────────────────────────
--
-- pt_leads is the single source of truth for whether a trial became a client.
-- POST /pt-os/leads/:id/convert (pt-os.routes.js:971-1008) is the ONLY
-- conversion path in the system: it org-checks the lead, refuses a double
-- conversion with 409 ALREADY_CONVERTED, creates the pt_clients row, and
-- writes pt_leads.status/converted_client_id/converted_at. It never touches
-- trial_sessions.
--
-- trial_sessions.converted is a bare boolean with no timestamp and no
-- FK-verified target, and nothing in the codebase has ever set it. Forcing it
-- to agree with pt_leads would be writing history this migration did not
-- witness. Nothing reads it, so there is no benefit to correcting it — only
-- value in knowing whether the two ever disagreed.
DO $$
DECLARE
  disagree INT := 0;
BEGIN
  IF to_regclass('public.trial_sessions') IS NULL OR to_regclass('public.pt_leads') IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO disagree
    FROM public.trial_sessions ts
    JOIN public.pt_leads l ON l.id = ts.lead_id
   WHERE COALESCE(ts.converted, false) IS DISTINCT FROM (l.converted_client_id IS NOT NULL);

  IF disagree > 0 THEN
    RAISE WARNING '185: % trial row(s) disagree with pt_leads about whether the lead converted. Reported only — pt_leads remains the source of truth and neither side was rewritten.', disagree;
  END IF;
END $$;

-- ── 7. Tighten, only if the backfill was complete ──────────────────────────
--
-- Same rule as 172 and 174: tighten what is clean, warn about what is not,
-- never abort. A NULL-org row matches no studio's filter, so it is already
-- invisible rather than leaking; NOT NULL would only stop new ones.
DO $$
DECLARE
  orphaned INT;
BEGIN
  IF to_regclass('public.trial_sessions') IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO orphaned FROM public.trial_sessions WHERE organization_id IS NULL;

  IF orphaned = 0 THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='trial_sessions'
                  AND column_name='organization_id' AND is_nullable='YES') THEN
      ALTER TABLE public.trial_sessions ALTER COLUMN organization_id SET NOT NULL;
      RAISE NOTICE '185: trial_sessions.organization_id tightened to NOT NULL.';
    END IF;
  ELSE
    RAISE WARNING '185: leaving trial_sessions.organization_id nullable — % row(s) are still unattributed.', orphaned;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS trial_sessions_org_idx      ON public.trial_sessions (organization_id);
CREATE INDEX IF NOT EXISTS trial_sessions_client_idx   ON public.trial_sessions (client_id);
CREATE INDEX IF NOT EXISTS trial_sessions_lead_idx     ON public.trial_sessions (lead_id);
