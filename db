-- ═══════════════════════════════════════════════════════════════════
--  619 Fitness Studio — SaaS v3 Schema (Glofox-class)
--
--  ADDITIVE migration. Run AFTER supabase-schema.sql (v2).
--  Safe to re-run: every CREATE/ALTER uses IF NOT EXISTS / IF EXISTS.
--
--  Run in Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ════════════════════════════════════════════════════════════════════
-- 1. BRANCHES (multi-location foundation; single row for now)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS branches (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  code          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  address       TEXT,
  phone         TEXT,
  email         TEXT,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency      TEXT NOT NULL DEFAULT 'INR',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO branches (id, code, name, address, phone, timezone, currency)
VALUES ('br-main', 'MAIN', '619 Fitness Studio', 'Your gym address', '+91-XXXXXXXXXX', 'Asia/Kolkata', 'INR')
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════
-- 2. EXTEND USERS for member role + better auth
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('admin','trainer','member','manager'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS member_id      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id      TEXT REFERENCES branches(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ;

-- ════════════════════════════════════════════════════════════════════
-- 3. REFRESH TOKENS (rotating refresh-token sessions)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  user_agent  TEXT,
  ip          TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

-- ════════════════════════════════════════════════════════════════════
-- 4. MEMBERS (extends/replaces clients; clients view kept for compat)
--    - Members may or may not have a login (users row).
--    - PT membership info now lives in member_memberships.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS members (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  branch_id       TEXT NOT NULL REFERENCES branches(id) DEFAULT 'br-main',
  member_code     TEXT UNIQUE NOT NULL,         -- e.g. FS0001
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  legacy_client_id TEXT,                         -- maps to clients.id during migration
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  gender          TEXT,
  dob             DATE,
  address         TEXT,
  emergency_contact TEXT,
  emergency_phone TEXT,
  primary_trainer_id TEXT REFERENCES trainers(id) ON DELETE SET NULL,
  joining_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('lead','active','frozen','expired','cancelled')),
  source          TEXT,                          -- referral, walk-in, instagram, etc.
  notes           TEXT,
  photo_url       TEXT,
  tags            TEXT[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_members_branch ON members(branch_id);
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_members_trainer ON members(primary_trainer_id);
CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);

-- Backfill members from existing clients (idempotent)
INSERT INTO members (id, branch_id, member_code, name, email, phone, gender, dob,
                     address, primary_trainer_id, joining_date, status, legacy_client_id, notes)
SELECT
  c.id, 'br-main',
  COALESCE(c.client_id, 'M' || LPAD((10000 + ROW_NUMBER() OVER (ORDER BY c.created_at))::text, 4, '0')),
  c.name, c.email, c.mobile, c.gender, c.dob, c.address, c.trainer_id,
  COALESCE(c.joining_date, CURRENT_DATE),
  CASE c.status WHEN 'frozen' THEN 'frozen' WHEN 'expired' THEN 'expired' ELSE 'active' END,
  c.id, c.notes
FROM clients c
ON CONFLICT (member_code) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════
-- 5. MEMBERSHIP PLANS (extends plans table)
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE plans ADD COLUMN IF NOT EXISTS branch_id     TEXT REFERENCES branches(id);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS plan_type     TEXT NOT NULL DEFAULT 'membership'
  CHECK (plan_type IN ('membership','class_pack','pt_pack','drop_in'));
ALTER TABLE plans ADD COLUMN IF NOT EXISTS included_classes INTEGER;        -- null = unlimited
ALTER TABLE plans ADD COLUMN IF NOT EXISTS included_pt_sessions INTEGER;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS auto_renew    BOOLEAN DEFAULT FALSE;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS color         TEXT DEFAULT '#FF4500';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS sort_order    INTEGER DEFAULT 0;

INSERT INTO plans (id, name, duration, price, plan_type, included_classes, branch_id, sort_order, is_active)
VALUES
  ('plan-mon',  'Monthly',         30,  3500.00, 'membership', NULL, 'br-main', 1, TRUE),
  ('plan-qtr',  'Quarterly',       90,  9000.00, 'membership', NULL, 'br-main', 2, TRUE),
  ('plan-half', 'Half Yearly',    180, 18000.00, 'membership', NULL, 'br-main', 3, TRUE),
  ('plan-yr',   'Yearly',         365, 30000.00, 'membership', NULL, 'br-main', 4, TRUE),
  ('plan-pt10', 'PT Pack — 10',    90, 12000.00, 'pt_pack',    NULL, 'br-main', 5, TRUE),
  ('plan-cls8', 'Class Pack — 8',  60,  4500.00, 'class_pack',    8, 'br-main', 6, TRUE),
  ('plan-drop', 'Drop-in',          1,   500.00, 'drop_in',       1, 'br-main', 7, TRUE)
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════
-- 6. MEMBER MEMBERSHIPS  (subscription instances)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS member_memberships (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plan_id         TEXT NOT NULL REFERENCES plans(id),
  trainer_id      TEXT REFERENCES trainers(id) ON DELETE SET NULL,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  base_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  final_amount    NUMERIC(10,2) NOT NULL DEFAULT 0,
  paid_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  balance_amount  NUMERIC(10,2) GENERATED ALWAYS AS (final_amount - paid_amount) STORED,
  classes_used    INTEGER NOT NULL DEFAULT 0,
  pt_sessions_used INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','expired','frozen','cancelled')),
  auto_renew      BOOLEAN NOT NULL DEFAULT FALSE,
  renewed_from_id TEXT REFERENCES member_memberships(id),
  notes           TEXT,
  created_by      TEXT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mm_member  ON member_memberships(member_id);
CREATE INDEX IF NOT EXISTS idx_mm_status  ON member_memberships(status);
CREATE INDEX IF NOT EXISTS idx_mm_end     ON member_memberships(end_date);

-- ════════════════════════════════════════════════════════════════════
-- 7. CLASSES — templates / schedules / sessions
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS class_templates (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  branch_id       TEXT NOT NULL REFERENCES branches(id) DEFAULT 'br-main',
  name            TEXT NOT NULL,                 -- "Yoga Flow", "HIIT 30"
  description     TEXT,
  category        TEXT,                          -- yoga, hiit, strength, dance
  duration_min    INTEGER NOT NULL DEFAULT 60,
  capacity        INTEGER NOT NULL DEFAULT 15,
  drop_in_fee     NUMERIC(10,2) DEFAULT 0,
  color           TEXT DEFAULT '#FF4500',
  image_url       TEXT,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS class_schedules (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  template_id     TEXT NOT NULL REFERENCES class_templates(id) ON DELETE CASCADE,
  trainer_id      TEXT REFERENCES trainers(id) ON DELETE SET NULL,
  -- iCal-ish recurrence: simplified
  rrule           TEXT,                          -- e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR"
  starts_on       DATE NOT NULL,
  ends_on         DATE,
  start_time      TIME NOT NULL,                 -- 07:00
  duration_min    INTEGER,                       -- override template
  capacity        INTEGER,                       -- override template
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS class_sessions (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  schedule_id     TEXT REFERENCES class_schedules(id) ON DELETE SET NULL,
  template_id     TEXT NOT NULL REFERENCES class_templates(id),
  trainer_id      TEXT REFERENCES trainers(id) ON DELETE SET NULL,
  branch_id       TEXT NOT NULL REFERENCES branches(id) DEFAULT 'br-main',
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  capacity        INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','cancelled','completed')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cs_starts ON class_sessions(starts_at);
CREATE INDEX IF NOT EXISTS idx_cs_trainer ON class_sessions(trainer_id, starts_at);

-- ════════════════════════════════════════════════════════════════════
-- 8. BOOKINGS  (member ↔ class_session)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bookings (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  session_id      TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  membership_id   TEXT REFERENCES member_memberships(id),
  status          TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed','waitlist','cancelled','no_show','attended')),
  position        INTEGER,                       -- waitlist position
  booked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at    TIMESTAMPTZ,
  cancellation_reason TEXT,
  checked_in_at   TIMESTAMPTZ,
  check_in_method TEXT,                          -- 'qr','manual','auto'
  notes           TEXT,
  UNIQUE (session_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_book_session ON bookings(session_id, status);
CREATE INDEX IF NOT EXISTS idx_book_member  ON bookings(member_id);

-- ════════════════════════════════════════════════════════════════════
-- 9. PERSONAL TRAINING SESSIONS
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pt_sessions (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  branch_id       TEXT NOT NULL REFERENCES branches(id) DEFAULT 'br-main',
  member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  trainer_id      TEXT NOT NULL REFERENCES trainers(id) ON DELETE RESTRICT,
  membership_id   TEXT REFERENCES member_memberships(id),
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','completed','cancelled','no_show')),
  goal            TEXT,                          -- "Squat PR", "Cardio block"
  trainer_notes   TEXT,
  member_feedback TEXT,
  rating          INTEGER CHECK (rating BETWEEN 1 AND 5),
  payout_eligible BOOLEAN NOT NULL DEFAULT TRUE,
  payout_amount   NUMERIC(10,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pt_trainer ON pt_sessions(trainer_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_pt_member  ON pt_sessions(member_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_pt_status  ON pt_sessions(status);

-- prevent overlapping bookings for the same trainer (key Glofox-beating feature)
CREATE OR REPLACE FUNCTION pt_no_overlap() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'scheduled' AND EXISTS (
    SELECT 1 FROM pt_sessions
    WHERE trainer_id = NEW.trainer_id
      AND id <> NEW.id
      AND status = 'scheduled'
      AND tstzrange(starts_at, ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'Trainer has a conflicting session at that time';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pt_no_overlap_trg ON pt_sessions;
CREATE TRIGGER pt_no_overlap_trg
  BEFORE INSERT OR UPDATE ON pt_sessions
  FOR EACH ROW EXECUTE FUNCTION pt_no_overlap();

-- ════════════════════════════════════════════════════════════════════
-- 10. PAYMENTS & INVOICES (extend v2 payments)
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE payments ADD COLUMN IF NOT EXISTS branch_id        TEXT REFERENCES branches(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS member_id        TEXT REFERENCES members(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS membership_id    TEXT REFERENCES member_memberships(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway          TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_txn_id   TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_status   TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS invoice_no       TEXT UNIQUE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_amount  NUMERIC(10,2) DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_by       TEXT REFERENCES users(id);

UPDATE payments SET branch_id = 'br-main' WHERE branch_id IS NULL;
UPDATE payments p SET member_id = (SELECT id FROM members WHERE legacy_client_id = p.client_id LIMIT 1)
  WHERE member_id IS NULL AND client_id IS NOT NULL;

-- Allow new gateway methods
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD  CONSTRAINT payments_method_check
  CHECK (method IN ('CASH','UPI','CARD','BANK_TRANSFER','RAZORPAY','STRIPE','WALLET'));

-- ════════════════════════════════════════════════════════════════════
-- 11. ATTENDANCE (extend for QR)
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS branch_id    TEXT REFERENCES branches(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS member_id    TEXT REFERENCES members(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS booking_id   TEXT REFERENCES bookings(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS pt_session_id TEXT REFERENCES pt_sessions(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_in_method TEXT;     -- qr/manual/auto
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS device_id    TEXT;        -- door scanner id
UPDATE attendance SET branch_id = 'br-main' WHERE branch_id IS NULL;

-- QR tokens (rotating, short-lived)
CREATE TABLE IF NOT EXISTS qr_tokens (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token       TEXT UNIQUE NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qr_token ON qr_tokens(token);

-- ════════════════════════════════════════════════════════════════════
-- 12. NOTIFICATIONS
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                  -- payment_due, class_reminder, etc.
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS notification_log (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  recipient_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  recipient_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('email','whatsapp','sms','push','inapp')),
  template    TEXT NOT NULL,
  payload     JSONB,
  status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','sent','delivered','failed','bounced')),
  provider_id TEXT,                            -- message id from provider
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_log_status ON notification_log(status);

-- ════════════════════════════════════════════════════════════════════
-- 13. BODY METRICS (generalizes weight_logs)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS body_metrics (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  date          DATE NOT NULL DEFAULT CURRENT_DATE,
  weight_kg     NUMERIC(5,2),
  body_fat_pct  NUMERIC(4,1),
  muscle_kg     NUMERIC(5,2),
  chest_cm      NUMERIC(5,1),
  waist_cm      NUMERIC(5,1),
  hip_cm        NUMERIC(5,1),
  arm_cm        NUMERIC(5,1),
  thigh_cm      NUMERIC(5,1),
  bmi           NUMERIC(4,1),
  notes         TEXT,
  recorded_by   TEXT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_metrics_member ON body_metrics(member_id, date DESC);

-- ════════════════════════════════════════════════════════════════════
-- 14. HOLDS / FREEZES
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS holds_freezes (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  membership_id   TEXT NOT NULL REFERENCES member_memberships(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL CHECK (reason IN ('medical','travel','personal','other')),
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  approved_by     TEXT REFERENCES users(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_freeze_membership ON holds_freezes(membership_id);

-- ════════════════════════════════════════════════════════════════════
-- 15. AUDIT LOG (append-only)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  action      TEXT NOT NULL,                -- e.g. 'member.update'
  entity      TEXT NOT NULL,                -- 'member','payment',...
  entity_id   TEXT,
  before      JSONB,
  after       JSONB,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id, created_at DESC);

-- ════════════════════════════════════════════════════════════════════
-- 16. REFERRALS (Glofox+ feature)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS referrals (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  referrer_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  referred_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  referral_code   TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','converted','expired')),
  reward_amount   NUMERIC(10,2),
  reward_status   TEXT DEFAULT 'pending'
                    CHECK (reward_status IN ('pending','credited','paid')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted_at    TIMESTAMPTZ
);

-- ════════════════════════════════════════════════════════════════════
-- 17. UPDATED_AT TRIGGER (DRY)
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'branches','members','member_memberships','class_templates',
    'class_sessions','pt_sessions'
  ]) LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS set_updated_at_trg ON %I;
       CREATE TRIGGER set_updated_at_trg BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();', t, t);
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- 18. CONVENIENCE VIEWS
-- ════════════════════════════════════════════════════════════════════

-- Active membership view: 1 row per member with their current plan
CREATE OR REPLACE VIEW v_member_active_membership AS
SELECT DISTINCT ON (m.id)
  m.id AS member_id, m.member_code, m.name,
  mm.id AS membership_id, mm.plan_id,
  pl.name AS plan_name,
  mm.start_date, mm.end_date, mm.status,
  mm.balance_amount,
  (mm.end_date - CURRENT_DATE) AS days_remaining
FROM members m
LEFT JOIN member_memberships mm ON mm.member_id = m.id AND mm.status = 'active'
LEFT JOIN plans pl ON pl.id = mm.plan_id
ORDER BY m.id, mm.end_date DESC NULLS LAST;

-- Class session occupancy view
CREATE OR REPLACE VIEW v_session_occupancy AS
SELECT
  cs.id AS session_id,
  cs.starts_at, cs.ends_at, cs.capacity,
  ct.name AS class_name, ct.category,
  t.name  AS trainer_name,
  COUNT(b.id) FILTER (WHERE b.status='confirmed')  AS confirmed,
  COUNT(b.id) FILTER (WHERE b.status='waitlist')   AS waitlisted,
  cs.capacity - COUNT(b.id) FILTER (WHERE b.status='confirmed') AS spots_left
FROM class_sessions cs
LEFT JOIN class_templates ct ON ct.id = cs.template_id
LEFT JOIN trainers t ON t.id = cs.trainer_id
LEFT JOIN bookings b ON b.session_id = cs.id
WHERE cs.status='scheduled'
GROUP BY cs.id, ct.name, ct.category, t.name;

-- Trainer monthly earnings view
CREATE OR REPLACE VIEW v_trainer_monthly_earnings AS
SELECT
  t.id AS trainer_id, t.name,
  TO_CHAR(p.date, 'YYYY-MM') AS month,
  COALESCE(SUM(p.amount), 0)         AS gross_revenue,
  COALESCE(SUM(p.incentive_amt), 0)  AS incentive,
  t.salary AS base_salary,
  t.salary + COALESCE(SUM(p.incentive_amt), 0) AS total_payout
FROM trainers t
LEFT JOIN payments p ON p.trainer_id = t.id
GROUP BY t.id, t.name, t.salary, TO_CHAR(p.date, 'YYYY-MM');

-- ════════════════════════════════════════════════════════════════════
-- 19. SEED — sample classes for the demo
-- ════════════════════════════════════════════════════════════════════
INSERT INTO class_templates (id, name, description, category, duration_min, capacity, color)
VALUES
  ('ct-yoga',  'Yoga Flow',     'Vinyasa-style yoga',          'yoga',     60, 15, '#8B5CF6'),
  ('ct-hiit',  'HIIT Burn',     'High-intensity intervals',    'hiit',     45, 12, '#EF4444'),
  ('ct-spin',  'Spin Express',  'Indoor cycling',              'cardio',   45, 20, '#3B82F6'),
  ('ct-zumba', 'Zumba Party',   'Dance fitness',               'dance',    60, 25, '#F59E0B')
ON CONFLICT (id) DO NOTHING;

-- Resilient seed: bind to whatever active trainers actually exist.
-- If you have fewer than 3 trainers, only that many demo schedules get created.
DO $$
DECLARE
  t_ids TEXT[];
BEGIN
  SELECT ARRAY(
    SELECT id FROM trainers
    WHERE COALESCE(status, 'active') = 'active'
    ORDER BY created_at NULLS LAST, id
    LIMIT 3
  ) INTO t_ids;

  IF array_length(t_ids, 1) >= 1 THEN
    INSERT INTO class_schedules (id, template_id, trainer_id, rrule, starts_on, start_time, capacity)
    VALUES ('sch-yoga-mwf', 'ct-yoga', t_ids[1], 'FREQ=WEEKLY;BYDAY=MO,WE,FR', CURRENT_DATE, '07:00', 15)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF array_length(t_ids, 1) >= 2 THEN
    INSERT INTO class_schedules (id, template_id, trainer_id, rrule, starts_on, start_time, capacity)
    VALUES ('sch-hiit-tt', 'ct-hiit', t_ids[2], 'FREQ=WEEKLY;BYDAY=TU,TH', CURRENT_DATE, '18:30', 12)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF array_length(t_ids, 1) >= 3 THEN
    INSERT INTO class_schedules (id, template_id, trainer_id, rrule, starts_on, start_time, capacity)
    VALUES ('sch-spin-mw', 'ct-spin', t_ids[3], 'FREQ=WEEKLY;BYDAY=MO,WE', CURRENT_DATE, '06:00', 20)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF array_length(t_ids, 1) IS NULL THEN
    RAISE NOTICE 'No trainers found — skipping demo class_schedules seed. Add trainers, then run the recovery patch.';
  END IF;
END $$;

-- Generate next 14 days of sessions from schedules (simplified, daily example)
INSERT INTO class_sessions (schedule_id, template_id, trainer_id, starts_at, ends_at, capacity, status)
SELECT
  sch.id, sch.template_id, sch.trainer_id,
  (d::date + sch.start_time)::timestamptz AS starts_at,
  (d::date + sch.start_time + (COALESCE(sch.duration_min, ct.duration_min) || ' minutes')::interval)::timestamptz AS ends_at,
  COALESCE(sch.capacity, ct.capacity),
  'scheduled'
FROM class_schedules sch
JOIN class_templates ct ON ct.id = sch.template_id
CROSS JOIN generate_series(CURRENT_DATE, CURRENT_DATE + 14, '1 day') d
WHERE sch.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════
-- 20. ROW-LEVEL SECURITY (foundation; enable per-tenant when ready)
-- ════════════════════════════════════════════════════════════════════
-- Examples (commented; enable after wiring auth.uid() context):
-- ALTER TABLE members ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY members_self ON members
--   FOR SELECT USING (
--     (current_setting('app.role', true) = 'admin')
--     OR (current_setting('app.role', true) = 'trainer' AND primary_trainer_id = current_setting('app.trainer_id', true))
--     OR (current_setting('app.role', true) = 'member'  AND user_id = current_setting('app.user_id', true))
--   );

-- DONE
SELECT '619 v3 schema applied successfully' AS status;
