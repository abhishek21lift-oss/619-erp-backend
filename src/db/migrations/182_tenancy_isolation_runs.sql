-- ============================================================
-- 182_tenancy_isolation_runs.sql
--
-- The Command Centre's "Run isolation tests" button. One row
-- per click, capturing: who clicked, when, how long it took,
-- and the per-tenant pass/fail rollup that the runner wrote.
--
-- The result is a JSONB blob rather than a normalised table
-- because the runner's structure changes as the test
-- surface changes, and the platform admin reading a row from
-- 18 months ago should see exactly what the runner produced
-- at the time — not a schema that the team has since moved
-- past. A normalised table would force a migration for every
-- test addition; a blob does not.
--
-- Retention is handled by a 180-day sweep (see the
-- tenancy-isolation-runs retention worker), not by a SQL
-- partition, because the write rate is one click per five
-- minutes per platform admin and the rows are not large.
--
-- Platform-only, behind requirePlatformOwner. Deny-all RLS below,
-- not the absence of RLS — the app_tenant role has no reason to
-- know how often isolation tests run, and a deny-all policy still
-- holds that even if a future grant is added by accident. The
-- platform route reads this via the owner connection, which
-- bypasses RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tenancy_isolation_runs (
  id            BIGSERIAL    PRIMARY KEY,
  ran_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  by_user_id    TEXT         NOT NULL,
  by_user_name  TEXT,
  duration_ms   INTEGER      NOT NULL,
  passed        BOOLEAN      NOT NULL,
  total_tests   INTEGER      NOT NULL,
  failed_tests  INTEGER      NOT NULL DEFAULT 0,
  result        JSONB        NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenancy_isolation_runs_ran_at
  ON public.tenancy_isolation_runs (ran_at DESC);

COMMENT ON TABLE public.tenancy_isolation_runs IS
  'One row per platform-triggered e2e tenant isolation test run. result is a JSONB snapshot of per-tenant outcomes. Platform-only; deny-all RLS, read via the owner connection.';

ALTER TABLE public.tenancy_isolation_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'tenancy_isolation_runs'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON public.tenancy_isolation_runs
      FOR ALL USING (false) WITH CHECK (false);
  END IF;

  -- Guarded: anon/authenticated are Supabase roles and do not exist on a plain
  -- Postgres. Migrations run automatically at boot, so an unguarded REVOKE
  -- would abort the boot of any deployment that is not Supabase.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.tenancy_isolation_runs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.tenancy_isolation_runs FROM authenticated;
  END IF;
END $$;
