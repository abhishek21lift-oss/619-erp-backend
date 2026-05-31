-- Run once to create the staff tables if they don't exist yet

CREATE TABLE IF NOT EXISTS staff (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  role        TEXT NOT NULL,   -- e.g. Admin, Manager, Trainer, Receptionist, Accountant, HR, Support
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_targets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id            UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  month               TEXT NOT NULL,          -- format: YYYY-MM
  target_revenue      NUMERIC(12,2) DEFAULT 0,
  target_clients      INT DEFAULT 0,
  target_sessions     INT DEFAULT 0,
  achieved_revenue    NUMERIC(12,2) DEFAULT 0,
  achieved_clients    INT DEFAULT 0,
  achieved_sessions   INT DEFAULT 0,
  UNIQUE (staff_id, month)
);
