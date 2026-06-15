-- ============================================================
-- 033_schema_fixes.sql
-- Addresses schema issues found during system audit:
--   1. Add missing indexes on high-frequency lookup columns
--   2. Rename unnumbered staff.sql tables to use TEXT PKs for
--      consistency (all other tables use TEXT DEFAULT gen_random_uuid()::TEXT)
--   3. Convert pt_clients date columns from TEXT to DATE
-- ============================================================

-- ── 1. Missing indexes ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS system_settings_key_idx   ON system_settings (key);
CREATE INDEX IF NOT EXISTS feature_flags_key_idx     ON feature_flags (key);
CREATE INDEX IF NOT EXISTS pt_clients_pt_end_date_idx ON pt_clients (pt_end_date);
CREATE INDEX IF NOT EXISTS attendance_logs_method_idx ON attendance_logs (method);
CREATE INDEX IF NOT EXISTS attendance_logs_date_idx   ON attendance_logs (date);

-- ── 2. staff table: UUID → TEXT primary key ───────────────────
-- Recreate staff and staff_targets with TEXT PKs to match the
-- rest of the schema. Safe to run multiple times (IF NOT EXISTS guards).

DO $$ BEGIN

  -- Only migrate if the PK is still UUID (idempotency check)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'staff'
      AND column_name = 'id'
      AND data_type = 'uuid'
  ) THEN

    -- Create new tables with TEXT PKs
    CREATE TABLE IF NOT EXISTS staff_new (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
      name        TEXT NOT NULL,
      email       TEXT,
      phone       TEXT,
      role        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS staff_targets_new (
      id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
      staff_id            TEXT NOT NULL REFERENCES staff_new(id) ON DELETE CASCADE,
      month               TEXT NOT NULL,
      target_revenue      NUMERIC(12,2) DEFAULT 0,
      target_clients      INT DEFAULT 0,
      target_sessions     INT DEFAULT 0,
      achieved_revenue    NUMERIC(12,2) DEFAULT 0,
      achieved_clients    INT DEFAULT 0,
      achieved_sessions   INT DEFAULT 0,
      UNIQUE (staff_id, month)
    );

    -- Migrate data (cast UUID → TEXT)
    INSERT INTO staff_new (id, name, email, phone, role, status, created_at)
    SELECT id::TEXT, name, email, phone, role, status, created_at
    FROM staff
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO staff_targets_new (id, staff_id, month, target_revenue, target_clients,
      target_sessions, achieved_revenue, achieved_clients, achieved_sessions)
    SELECT id::TEXT, staff_id::TEXT, month, target_revenue, target_clients,
      target_sessions, achieved_revenue, achieved_clients, achieved_sessions
    FROM staff_targets
    ON CONFLICT DO NOTHING;

    -- Drop old tables and rename
    DROP TABLE IF EXISTS staff_targets;
    DROP TABLE IF EXISTS staff;
    ALTER TABLE staff_new RENAME TO staff;
    ALTER TABLE staff_targets_new RENAME TO staff_targets;

  END IF;

END $$;

-- ── 3. pt_clients date columns: TEXT → DATE ───────────────────
-- Only alter columns that are still TEXT type.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pt_clients'
      AND column_name = 'dob'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE pt_clients
      ALTER COLUMN dob          TYPE DATE USING NULLIF(TRIM(dob), '')::DATE,
      ALTER COLUMN joining_date TYPE DATE USING NULLIF(TRIM(joining_date), '')::DATE,
      ALTER COLUMN pt_start_date TYPE DATE USING NULLIF(TRIM(pt_start_date), '')::DATE,
      ALTER COLUMN pt_end_date   TYPE DATE USING NULLIF(TRIM(pt_end_date), '')::DATE;
  END IF;
END $$;
