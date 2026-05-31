-- Migration 015: Add missing tables, constraints, and indexes
-- Created: 2026-05-31
-- 
-- This migration adds tables that are referenced by existing FK
-- constraints and application code but were never created in schema.sql
-- or any prior migration.

-- ─── BRANCHES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name        TEXT        NOT NULL,
  code        TEXT        UNIQUE,
  address     TEXT,
  phone       TEXT,
  email       TEXT,
  manager     TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert a default branch so existing FK references have a target
INSERT INTO branches (id, name, code)
SELECT 'main', 'Main Studio', 'MAIN'
WHERE NOT EXISTS (SELECT 1 FROM branches WHERE id = 'main');

-- ─── BOOKINGS / CLASS SCHEDULING ─────────────────────────────
CREATE TABLE IF NOT EXISTS class_templates (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name          TEXT        NOT NULL,
  description   TEXT,
  category      TEXT,
  duration_min  INT         NOT NULL DEFAULT 60,
  capacity      INT         NOT NULL DEFAULT 20,
  color         TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS class_sessions (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  template_id     TEXT        REFERENCES class_templates(id) ON DELETE CASCADE,
  title           TEXT        NOT NULL,
  description     TEXT,
  instructor_id   TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
  instructor_name TEXT,
  date            DATE        NOT NULL,
  start_time      TIME        NOT NULL,
  end_time        TIME        NOT NULL,
  capacity        INT         NOT NULL DEFAULT 20,
  booked_count    INT         NOT NULL DEFAULT 0,
  location        TEXT,
  status          TEXT        NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cs_date_idx ON class_sessions (date);
CREATE INDEX IF NOT EXISTS cs_instructor_idx ON class_sessions (instructor_id);
CREATE INDEX IF NOT EXISTS cs_status_idx ON class_sessions (status);

CREATE TABLE IF NOT EXISTS bookings (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  session_id      TEXT        NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  client_id       TEXT        REFERENCES clients(id) ON DELETE CASCADE,
  member_id       TEXT,
  client_name     TEXT,
  status          TEXT        NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed','checked_in','cancelled','no_show')),
  checked_in_at   TIMESTAMPTZ,
  booked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bookings_session_idx ON bookings (session_id);
CREATE INDEX IF NOT EXISTS bookings_client_idx ON bookings (client_id);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_session_client_uniq ON bookings (session_id, COALESCE(client_id, member_id))
  WHERE status IN ('confirmed','checked_in');

-- ─── MEMBER PORTAL TABLES ────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT        NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  user_id         TEXT        UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  email           TEXT,
  phone           TEXT,
  profile_pic     TEXT,
  date_of_birth   DATE,
  emergency_contact TEXT,
  preferences     JSONB       DEFAULT '{}',
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS member_memberships (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  member_id       TEXT        NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  subscription_id TEXT        REFERENCES subscriptions(id) ON DELETE SET NULL,
  plan_name       TEXT        NOT NULL,
  start_date      DATE        NOT NULL,
  end_date        DATE        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','expired','cancelled','frozen')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mm_member_idx ON member_memberships (member_id);
CREATE INDEX IF NOT EXISTS mm_status_idx ON member_memberships (status);

CREATE TABLE IF NOT EXISTS holds_freezes (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  subscription_id TEXT        REFERENCES subscriptions(id) ON DELETE CASCADE,
  reason          TEXT,
  freeze_from     DATE        NOT NULL,
  freeze_until    DATE        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','expired')),
  created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hf_client_idx ON holds_freezes (client_id);

-- ─── BODY METRICS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS body_metrics (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  weight          NUMERIC(6,2),
  body_fat_pct    NUMERIC(5,2),
  muscle_mass     NUMERIC(6,2),
  bmi             NUMERIC(5,2),
  chest           NUMERIC(6,2),
  waist           NUMERIC(6,2),
  hips            NUMERIC(6,2),
  arms            NUMERIC(6,2),
  thighs          NUMERIC(6,2),
  notes           TEXT,
  measured_at     DATE        NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bm_client_idx ON body_metrics (client_id, measured_at DESC);

-- ─── PT SESSIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pt_sessions (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  trainer_id      TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
  session_date    DATE        NOT NULL,
  start_time      TIME,
  end_time        TIME,
  status          TEXT        NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','completed','cancelled','no_show')),
  notes           TEXT,
  created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pts_client_idx ON pt_sessions (client_id, session_date DESC);
CREATE INDEX IF NOT EXISTS pts_trainer_idx ON pt_sessions (trainer_id, session_date DESC);
CREATE INDEX IF NOT EXISTS pts_date_idx ON pt_sessions (session_date);

-- ─── AUDIT LOG (separate from activity_log) ──────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  table_name      TEXT        NOT NULL,
  record_id       TEXT,
  action          TEXT        NOT NULL,
  old_data        JSONB,
  new_data        JSONB,
  changed_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_table_idx ON audit_log (table_name, record_id);
CREATE INDEX IF NOT EXISTS audit_date_idx ON audit_log (created_at DESC);

-- ─── MISSING CONSTRAINTS ─────────────────────────────────────
-- Unique constraint on clients phone (non-empty only)
CREATE UNIQUE INDEX IF NOT EXISTS clients_mobile_uniq ON clients (mobile)
  WHERE mobile IS NOT NULL AND mobile != '';

-- Index on staff_targets(staff_id) for FK join performance
CREATE INDEX IF NOT EXISTS st_staff_idx ON staff_targets (staff_id);

-- Add updated_at triggers to tables that don't have them
DO $$ DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['payments','renewals','notifications','activity_log',
                               'face_descriptors','weight_logs','body_metrics',
                               'pt_sessions','branches','members','member_memberships',
                               'bookings','class_sessions','class_templates'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_' || t || '_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_%I_updated_at
           BEFORE UPDATE ON %I
           FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        t, t
      );
    END IF;
  END LOOP;
END $$;
