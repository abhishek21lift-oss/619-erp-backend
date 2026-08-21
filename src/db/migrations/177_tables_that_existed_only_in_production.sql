-- 177_tables_that_existed_only_in_production.sql
--
-- Two tables the application reads and writes that no migration ever created.
--
-- ── How they were found ────────────────────────────────────────────────────
--
-- The audit's Section 11 asked for "a test that fails if any table appears in
-- application SQL but in no migration — the module_records case". Building it
-- (src/__tests__/orphanTables.convention.test.js) turned up two more of
-- exactly that shape:
--
--   notification_log      INSERTed by modules/notifications/notifications.service.js
--   pt_os_measurements    read by client-portal and the pt-os client snapshot
--
-- Both exist in production and in no migration, so a fresh install — a new
-- environment, a restored-from-schema staging box, CI — does not have them.
-- Verified against production: both present, both empty.
--
-- ── What that cost, before this ────────────────────────────────────────────
--
-- Neither failure was loud, which is why they survived:
--
--   notifications.service.js wraps its INSERT in try/catch and logs
--   "notification_log table may not exist yet" — so on a fresh install every
--   notification delivery attempt is recorded nowhere and the only trace is a
--   warning nobody reads.
--
--   client-portal.routes.js carries a comment explaining that the table "is
--   not defined in any migration in this repo — it is created elsewhere", and
--   deliberately selects two columns rather than star BECAUSE the shape could
--   not be verified from the repo. A correct workaround for a problem that
--   should not have existed.
--
-- This is the same divergence as class_sessions (see PR #82): the schema a
-- fresh install builds and the schema production actually runs had drifted,
-- and nothing compared them.
--
-- ── What this migration does, and does not, do ─────────────────────────────
--
-- Creates both with EXACTLY the shape production already has, column for
-- column, read from pg_attribute rather than guessed. On production every
-- statement here is a no-op; on a fresh install it closes the gap. No column
-- is added, no type widened, no default changed — the point is convergence,
-- not improvement, and a shape change would need its own migration and its
-- own argument.
--
-- Deliberately NOT given organization_id here:
--
--   pt_os_measurements is a child row reached only through its parent — both
--   readers scope on a client_id that comes from the session, never from the
--   request — which is this codebase's documented pattern for such tables
--   (see the header of modules/training/authz.js). It goes on
--   NO_TENANT_COLUMN_BY_DESIGN with that reason.
--
--   notification_log is write-only: nothing in the codebase SELECTs from it,
--   so there is no read path to leak across studios. It should carry the
--   column eventually — a delivery log that cannot say which studio a message
--   belonged to is a poor audit trail — but adding it means changing the one
--   INSERT and deciding what an org-less system notification records, which is
--   a change with an argument attached rather than a no-op. It goes on
--   KNOWN_GAPS with that reason, which raises the pinned debt count.

-- ── notification_log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_log (
  id                  TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  recipient_user_id   TEXT,
  recipient_member_id TEXT,
  channel             TEXT        NOT NULL,
  template            TEXT        NOT NULL,
  payload             JSONB,
  status              TEXT        NOT NULL DEFAULT 'queued',
  provider_id         TEXT,
  error               TEXT,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notification_log_created_idx
  ON notification_log (created_at DESC);
CREATE INDEX IF NOT EXISTS notification_log_recipient_idx
  ON notification_log (recipient_user_id, recipient_member_id);

-- ── pt_os_measurements ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pt_os_measurements (
  id              TEXT          PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT          NOT NULL,
  assignment_id   TEXT,
  weight_kg       NUMERIC(5,2),
  body_fat_pct    NUMERIC(4,1),
  chest_cm        NUMERIC(5,2),
  waist_cm        NUMERIC(5,2),
  arms_cm         NUMERIC(5,2),
  thighs_cm       NUMERIC(5,2),
  calves_cm       NUMERIC(5,2),
  shoulders_cm    NUMERIC(5,2),
  neck_cm         NUMERIC(5,2),
  hip_cm          NUMERIC(5,2),
  bmi             NUMERIC(4,1),
  bmr             INTEGER,
  photo_front_url TEXT,
  photo_side_url  TEXT,
  photo_back_url  TEXT,
  notes           TEXT,
  measured_by     TEXT,
  measured_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Both readers filter on client_id and order by measured_at DESC.
CREATE INDEX IF NOT EXISTS pt_os_measurements_client_idx
  ON pt_os_measurements (client_id, measured_at DESC);

-- client_id has no FK in production, so none is added here: adding one would
-- be a shape change, and on a database whose rows predate the constraint it
-- could fail the deploy. Recorded rather than silently corrected.

-- ── RLS ────────────────────────────────────────────────────────────────────
--
-- Migration 131 converged every table in public to RLS-enabled, so a table
-- created here on a fresh install must get its policy here too — 157 has
-- already run and will not revisit. Without this they would sit with RLS on
-- and no policy naming app_tenant, which does not raise: it returns zero rows.
-- That is the mistake 174's first draft made and CI caught.
--
-- Neither table carries organization_id, so neither can use the standard
-- predicate. pt_os_measurements is reached through pt_clients, so it gets the
-- parent walk migration 159 uses for exactly this shape. notification_log is
-- write-only from the application and has no tenant key at all; app_tenant is
-- granted INSERT only, which is precisely what the service does.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    RAISE NOTICE '177: app_tenant absent, skipping policy creation';
    RETURN;
  END IF;

  ALTER TABLE public.pt_os_measurements ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON public.pt_os_measurements;
  CREATE POLICY tenant_isolation ON public.pt_os_measurements FOR ALL TO app_tenant
    USING (EXISTS (
      SELECT 1 FROM pt_clients c
       WHERE c.id = pt_os_measurements.client_id
         AND c.organization_id::text = current_setting('app.org_id', true)))
    WITH CHECK (EXISTS (
      SELECT 1 FROM pt_clients c
       WHERE c.id = pt_os_measurements.client_id
         AND c.organization_id::text = current_setting('app.org_id', true)));

  ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_insert_only ON public.notification_log;
  CREATE POLICY tenant_insert_only ON public.notification_log FOR INSERT TO app_tenant
    WITH CHECK (true);
END $$;

-- PostgREST roles never reach either table.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_log','pt_os_measurements']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
