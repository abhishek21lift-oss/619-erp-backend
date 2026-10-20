-- ============================================================
-- 231_module5_progress_habits.sql
-- Module 5 — progress tracking and re-test scheduling.
--
-- Additive only. Reuses pt_assessments (the existing seven-step fitness
-- test) rather than creating a second assessment system. New state:
--
--   progress_retest_settings      per-studio cadence and reminder days
--   progress_retest_schedules     the next test, derived from a real baseline
--   progress_reminder_deliveries  exactly-once reminder ledger
--   client_habit_logs             one daily journal row per member per day
--   client_habit_preferences      member targets / wearable preference
--   progress_insight_reviews      trainer's record of reviewing an insight
--
-- No BEGIN/COMMIT here: migrate.js wraps each migration.
-- ============================================================

-- Where a test was taken: time of day, fasted state, equipment, hydration.
-- Existing notes stay untouched; this is a dedicated field so comparisons can
-- show the conditions without parsing free text.
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS testing_conditions TEXT;

-- ── Per-studio re-test policy ───────────────────────────────
CREATE TABLE IF NOT EXISTS progress_retest_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  cadence_months  INT NOT NULL DEFAULT 4
                  CHECK (cadence_months BETWEEN 4 AND 6),
  reminder_days   INT[] NOT NULL DEFAULT ARRAY[30, 14, 7]
                  CHECK (array_length(reminder_days, 1) BETWEEN 1 AND 6),
  is_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── The schedule ────────────────────────────────────────────
-- One row per baseline. Rescheduling updates the same row so the original
-- date survives in rescheduled_from; completing a test closes the row and the
-- next baseline opens a new one. Missing baseline has no row at all — the
-- service prompts for an initial assessment instead of inventing a date.
CREATE TABLE IF NOT EXISTS progress_retest_schedules (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id               TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  baseline_assessment_id  TEXT REFERENCES pt_assessments(id) ON DELETE SET NULL,
  completed_assessment_id TEXT REFERENCES pt_assessments(id) ON DELETE SET NULL,
  scheduled_date          DATE NOT NULL,
  cadence_months          INT NOT NULL CHECK (cadence_months BETWEEN 4 AND 6),
  status                  TEXT NOT NULL DEFAULT 'upcoming'
                          CHECK (status IN ('upcoming','due','overdue','completed','rescheduled','cancelled')),
  source                  TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')),
  rescheduled_from        DATE,
  reschedule_reason       TEXT,
  notes                   TEXT,
  completed_at            TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,
  created_by              TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by              TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe for a database that applied an earlier draft of this migration.
ALTER TABLE progress_retest_schedules
  ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completed_by TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS progress_retest_client_idx
  ON progress_retest_schedules (organization_id, client_id, scheduled_date DESC);
CREATE INDEX IF NOT EXISTS progress_retest_due_idx
  ON progress_retest_schedules (organization_id, status, scheduled_date);
-- At most one open cycle per client. Completed/cancelled rows are history.
CREATE UNIQUE INDEX IF NOT EXISTS progress_retest_one_open_per_client
  ON progress_retest_schedules (client_id)
  WHERE status IN ('upcoming','due','overdue','rescheduled');

-- ── Reminder ledger ─────────────────────────────────────────
-- The unique key is the whole idempotency rule: a retried sweep finds the row
-- it already wrote and does not message the client twice. A failed attempt is
-- retried by updating the same row, never by inserting a second one.
CREATE TABLE IF NOT EXISTS progress_reminder_deliveries (
  id               BIGSERIAL PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  schedule_id      TEXT NOT NULL REFERENCES progress_retest_schedules(id) ON DELETE CASCADE,
  client_id        TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('reminder','due','overdue')),
  stage_days       INT NOT NULL,
  due_date         DATE NOT NULL,
  recipient        TEXT NOT NULL DEFAULT 'client',
  channel          TEXT NOT NULL DEFAULT 'inapp',
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','failed','skipped')),
  attempts         INT NOT NULL DEFAULT 0,
  last_error       TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe for a database that applied an earlier draft of this migration: add the
-- recipient, keep the old rows as client deliveries, and widen the idempotency
-- key so the trainer's copy is tracked independently.
ALTER TABLE progress_reminder_deliveries
  ADD COLUMN IF NOT EXISTS recipient TEXT NOT NULL DEFAULT 'client';

-- Drop the earlier draft's four-column uniqueness by its shape, not by a
-- guessed name. PostgreSQL truncates identifiers at 63 bytes and chooses a
-- different spelling for an auto-named UNIQUE constraint than for the explicit
-- name this migration used to drop, so a name-based DROP can silently leave
-- the narrow key in place and make the trainer's copy collide with the
-- client's. Match the exact column set instead.
DO $$
DECLARE
  old_cols smallint[];
  old_obj record;
BEGIN
  SELECT array_agg(attnum ORDER BY attnum) INTO old_cols
    FROM pg_attribute
   WHERE attrelid = 'public.progress_reminder_deliveries'::regclass
     AND attname IN ('schedule_id', 'kind', 'stage_days', 'due_date');

  FOR old_obj IN
    SELECT conname AS name, 'constraint' AS kind
      FROM pg_constraint
     WHERE conrelid = 'public.progress_reminder_deliveries'::regclass
       AND contype = 'u'
       AND (SELECT array_agg(k ORDER BY k) FROM unnest(conkey) k) = old_cols
    UNION ALL
    SELECT c.relname AS name, 'index' AS kind
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.progress_reminder_deliveries'::regclass
       AND i.indisunique
       AND NOT i.indisprimary
       AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
       AND (SELECT array_agg(k ORDER BY k) FROM unnest(i.indkey::smallint[]) k) = old_cols
  LOOP
    IF old_obj.kind = 'constraint' THEN
      EXECUTE format('ALTER TABLE public.progress_reminder_deliveries DROP CONSTRAINT %I', old_obj.name);
    ELSE
      EXECUTE format('DROP INDEX public.%I', old_obj.name);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'progress_reminder_deliveries_recipient_check'
  ) THEN
    ALTER TABLE progress_reminder_deliveries
      ADD CONSTRAINT progress_reminder_deliveries_recipient_check
      CHECK (recipient IN ('client','trainer'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS progress_reminder_delivery_recipient_key
  ON progress_reminder_deliveries (schedule_id, kind, stage_days, due_date, recipient);

CREATE INDEX IF NOT EXISTS progress_reminder_pending_idx
  ON progress_reminder_deliveries (organization_id, status, created_at);

-- ── Daily habit journal ─────────────────────────────────────
-- One row per member per calendar day. log_date is the member's studio-local
-- day (the API resolves it with the org timezone); logged_at is the instant.
CREATE TABLE IF NOT EXISTS client_habit_logs (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  log_date          DATE NOT NULL,
  sleep_hours       NUMERIC(4,1) CHECK (sleep_hours IS NULL OR sleep_hours BETWEEN 0 AND 24),
  sleep_quality     SMALLINT CHECK (sleep_quality IS NULL OR sleep_quality BETWEEN 1 AND 5),
  water_ml          INT CHECK (water_ml IS NULL OR water_ml BETWEEN 0 AND 15000),
  electrolytes      BOOLEAN,
  steps             INT CHECK (steps IS NULL OR steps BETWEEN 0 AND 200000),
  steps_source      TEXT CHECK (steps_source IS NULL OR steps_source IN ('manual','wearable','imported')),
  stress_level      SMALLINT CHECK (stress_level IS NULL OR stress_level BETWEEN 1 AND 5),
  energy_level      SMALLINT CHECK (energy_level IS NULL OR energy_level BETWEEN 1 AND 5),
  fatigue_level     SMALLINT CHECK (fatigue_level IS NULL OR fatigue_level BETWEEN 1 AND 5),
  soreness_level    SMALLINT CHECK (soreness_level IS NULL OR soreness_level BETWEEN 1 AND 5),
  recovery_level    SMALLINT CHECK (recovery_level IS NULL OR recovery_level BETWEEN 1 AND 5),
  notes             TEXT,
  source            TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual','wearable','imported','mixed')),
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, log_date)
);

CREATE INDEX IF NOT EXISTS client_habit_logs_client_date_idx
  ON client_habit_logs (organization_id, client_id, log_date DESC);

CREATE TABLE IF NOT EXISTS client_habit_preferences (
  client_id          TEXT PRIMARY KEY REFERENCES pt_clients(id) ON DELETE CASCADE,
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sleep_target_min   NUMERIC(4,1) NOT NULL DEFAULT 7
                     CHECK (sleep_target_min BETWEEN 0 AND 24),
  sleep_target_max   NUMERIC(4,1) NOT NULL DEFAULT 9
                     CHECK (sleep_target_max BETWEEN 0 AND 24),
  water_target_ml    INT CHECK (water_target_ml IS NULL OR water_target_ml BETWEEN 0 AND 15000),
  step_target        INT CHECK (step_target IS NULL OR step_target BETWEEN 0 AND 200000),
  reminder_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_time      TIME,
  wearable_provider  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sleep_target_max >= sleep_target_min)
);

-- ── Trainer review of a generated insight ───────────────────
-- No program is changed from an insight. This row is the trainer's explicit
-- acknowledgement, kept as history so "reviewed" is not a UI-only claim.
CREATE TABLE IF NOT EXISTS progress_insight_reviews (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  insight_key     TEXT NOT NULL,
  insight_type    TEXT NOT NULL CHECK (insight_type IN ('observation','recommendation')),
  title           TEXT NOT NULL,
  observation     TEXT,
  recommendation  TEXT,
  decision        TEXT NOT NULL CHECK (decision IN ('acknowledged','approved','dismissed')),
  reviewed_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS progress_insight_reviews_client_idx
  ON progress_insight_reviews (organization_id, client_id, created_at DESC);

-- ── Existing studios and clients ────────────────────────────
-- A studio with no row uses the defaults in the service. Giving every studio
-- an explicit row makes the setting visible in the UI immediately.
INSERT INTO progress_retest_settings (organization_id)
SELECT id FROM organizations
ON CONFLICT (organization_id) DO NOTHING;

-- Existing clients already have a real baseline. Open their first cycle from
-- the latest completed assessment so nobody has to be scheduled by hand. A
-- studio that later changes its cadence keeps these already-promised dates;
-- the next completion uses the new cadence.
WITH latest AS (
  SELECT DISTINCT ON (a.client_id)
         a.id, a.client_id, a.organization_id, a.assessment_date
    FROM pt_assessments a
   WHERE a.organization_id IS NOT NULL
   ORDER BY a.client_id, a.assessment_date DESC, a.created_at DESC
)
INSERT INTO progress_retest_schedules
  (organization_id, client_id, baseline_assessment_id, scheduled_date,
   cadence_months, status, source)
SELECT l.organization_id, l.client_id, l.id,
       (l.assessment_date + (COALESCE(s.cadence_months, 4) || ' months')::interval)::date,
       COALESCE(s.cadence_months, 4), 'upcoming', 'auto'
  FROM latest l
  LEFT JOIN progress_retest_settings s ON s.organization_id = l.organization_id
 WHERE NOT EXISTS (
   SELECT 1 FROM progress_retest_schedules r
    WHERE r.client_id = l.client_id
      AND r.status IN ('upcoming','due','overdue','rescheduled')
 )
ON CONFLICT DO NOTHING;

-- ── RLS: both halves ────────────────────────────────────────
-- deny_all keeps the tables off PostgREST with the publishable key; the
-- tenant_isolation policy and GRANT let the API (app_tenant) use them at all.
-- Same pattern as client_messages (211) and ai_workout_generations (199).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'progress_retest_settings', 'progress_retest_schedules',
    'progress_reminder_deliveries', 'client_habit_logs',
    'client_habit_preferences', 'progress_insight_reviews'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON %I', t);
    EXECUTE format('CREATE POLICY deny_all_direct_access ON %I FOR ALL USING (false) WITH CHECK (false)', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO app_tenant '
      'USING (organization_id::text = current_setting(''app.org_id'', true)) '
      'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_tenant', t);
  END LOOP;
END $$;

-- The delivery ledger uses a BIGSERIAL; app_tenant needs the sequence too.
GRANT USAGE, SELECT ON SEQUENCE progress_reminder_deliveries_id_seq TO app_tenant;
