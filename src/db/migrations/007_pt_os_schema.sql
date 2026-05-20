-- 007_pt_os_schema.sql
-- PT Operating System — premium personal training tables.
-- Runs after 006_premium_features.sql.
--
-- Design reference: docs/PT-OPERATING-SYSTEM-DESIGN.md (Section 18)
--
-- This migration adds a complete PT OS layer on top of the existing
-- trainers / clients tables. All new tables use the pt_os_ prefix to
-- avoid conflicting with the v3 pt_sessions / members module tables.


-- ─── PT PACKAGES ───────────────────────────────────────────────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_os_packages (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    name            VARCHAR(100) NOT NULL,
    type            VARCHAR(50) NOT NULL
                    CHECK (type IN ('session_based','monthly','transformation','online','diet')),
    sessions        INT,
    duration_days   INT,
    price           DECIMAL(10,2) NOT NULL DEFAULT 0,
    commission_pct  DECIMAL(5,2) NOT NULL DEFAULT 60.00
                    CHECK (commission_pct BETWEEN 0 AND 100),
    description     TEXT,
    features        JSONB       DEFAULT '[]',
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    branch_id       TEXT,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_packages table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pt_os_packages_active_idx ON pt_os_packages (is_active) WHERE is_active = TRUE;
  CREATE INDEX IF NOT EXISTS pt_os_packages_type_idx   ON pt_os_packages (type);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_packages indexes: %', SQLERRM; END $$;


-- ─── PT CLIENT ASSIGNMENTS ─────────────────────────────────────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_os_assignments (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    trainer_id      TEXT        NOT NULL REFERENCES trainers(id) ON DELETE RESTRICT,
    package_id      TEXT        REFERENCES pt_os_packages(id) ON DELETE RESTRICT,
    sessions_total  INT         NOT NULL DEFAULT 0
                    CHECK (sessions_total >= 0),
    sessions_used   INT         NOT NULL DEFAULT 0
                    CHECK (sessions_used >= 0 AND sessions_used <= sessions_total),
    start_date      DATE        NOT NULL,
    end_date        DATE,
    amount          DECIMAL(10,2) NOT NULL DEFAULT 0,
    discount        DECIMAL(10,2) NOT NULL DEFAULT 0,
    final_amount    DECIMAL(10,2) NOT NULL DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','completed','cancelled','expired','refunded')),
    health_score    INT         CHECK (health_score BETWEEN 0 AND 100),
    adherence_pct   DECIMAL(5,2) CHECK (adherence_pct BETWEEN 0 AND 100),
    notes           TEXT,
    cancelled_at    TIMESTAMPTZ,
    cancelled_by    TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_assignments table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pt_os_assignments_client_idx  ON pt_os_assignments (client_id);
  CREATE INDEX IF NOT EXISTS pt_os_assignments_trainer_idx ON pt_os_assignments (trainer_id);
  CREATE INDEX IF NOT EXISTS pt_os_assignments_status_idx  ON pt_os_assignments (status);
  CREATE INDEX IF NOT EXISTS pt_os_assignments_end_date_idx ON pt_os_assignments (end_date) WHERE status = 'active';
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_assignments indexes: %', SQLERRM; END $$;


-- ─── PT OS SESSIONS (premium coaching sessions) ────────────────
-- NOTE: This is separate from the v3 pt_sessions table used by
-- /api/v1/pt-sessions. This one tracks completed/rich session data
-- for the PT OS coaching workflow.
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_os_sessions (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    assignment_id   TEXT        REFERENCES pt_os_assignments(id) ON DELETE CASCADE,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    trainer_id      TEXT        NOT NULL REFERENCES trainers(id) ON DELETE RESTRICT,
    scheduled_at    TIMESTAMPTZ NOT NULL,
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    duration_min    INT         CHECK (duration_min > 0),
    status          VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','completed','missed','cancelled','rescheduled')),
    session_type    VARCHAR(50) NOT NULL DEFAULT 'in_person'
                    CHECK (session_type IN ('in_person','virtual','outdoor','home')),
    goal            TEXT,
    notes           TEXT,
    trainer_notes   TEXT,
    client_feedback TEXT,
    trainer_rating  INT         CHECK (trainer_rating BETWEEN 1 AND 5),
    exercises       JSONB       DEFAULT '[]',
    volume_kg       DECIMAL(10,2),
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_sessions table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pt_os_sessions_assignment_idx ON pt_os_sessions (assignment_id);
  CREATE INDEX IF NOT EXISTS pt_os_sessions_client_idx     ON pt_os_sessions (client_id);
  CREATE INDEX IF NOT EXISTS pt_os_sessions_trainer_idx    ON pt_os_sessions (trainer_id);
  CREATE INDEX IF NOT EXISTS pt_os_sessions_scheduled_idx  ON pt_os_sessions (scheduled_at DESC);
  CREATE INDEX IF NOT EXISTS pt_os_sessions_status_idx     ON pt_os_sessions (status);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_sessions indexes: %', SQLERRM; END $$;

-- Conflict prevention: no two sessions for the same trainer at the same time
DO $$ BEGIN
  CREATE OR REPLACE FUNCTION pt_os_no_overlap()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pt_os_sessions
      WHERE trainer_id = NEW.trainer_id
        AND status NOT IN ('cancelled','missed')
        AND id <> COALESCE(NEW.id, '')
        AND tstzrange(NEW.scheduled_at, NEW.scheduled_at + interval '1 hour') && tstzrange(scheduled_at, scheduled_at + interval '1 hour')
    ) THEN
      RAISE EXCEPTION 'conflicting session — trainer already has a session within this hour';
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS trg_pt_os_no_overlap ON pt_os_sessions;
  CREATE TRIGGER trg_pt_os_no_overlap
    BEFORE INSERT OR UPDATE ON pt_os_sessions
    FOR EACH ROW EXECUTE FUNCTION pt_os_no_overlap();
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_sessions trigger: %', SQLERRM; END $$;


-- ─── PT PAYMENTS ───────────────────────────────────────────────
-- Separate from the main payments table to isolate PT revenue.
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_os_payments (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    assignment_id   TEXT        REFERENCES pt_os_assignments(id) ON DELETE RESTRICT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    amount          DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    payment_type    VARCHAR(50) NOT NULL
                    CHECK (payment_type IN ('package','installment','renewal','addon','upgrade')),
    payment_method  VARCHAR(50) DEFAULT 'CASH'
                    CHECK (payment_method IN ('CASH','UPI','CARD','BANK_TRANSFER','CHEQUE','FREE')),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','completed','refunded','failed')),
    due_date        DATE,
    paid_at         TIMESTAMPTZ,
    receipt_no      VARCHAR(50),
    notes           TEXT,
    recorded_by     TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_payments table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pt_os_payments_assignment_idx ON pt_os_payments (assignment_id);
  CREATE INDEX IF NOT EXISTS pt_os_payments_client_idx     ON pt_os_payments (client_id);
  CREATE INDEX IF NOT EXISTS pt_os_payments_status_idx     ON pt_os_payments (status);
  CREATE INDEX IF NOT EXISTS pt_os_payments_due_date_idx   ON pt_os_payments (due_date) WHERE status = 'pending';
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_payments indexes: %', SQLERRM; END $$;


-- ─── TRAINER EARNINGS (commissions + incentives + bonuses) ─────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_os_earnings (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    trainer_id      TEXT        NOT NULL REFERENCES trainers(id) ON DELETE RESTRICT,
    payment_id      TEXT        REFERENCES pt_os_payments(id) ON DELETE SET NULL,
    session_id      TEXT        REFERENCES pt_os_sessions(id) ON DELETE SET NULL,
    assignment_id   TEXT        REFERENCES pt_os_assignments(id) ON DELETE SET NULL,
    amount          DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    type            VARCHAR(50) NOT NULL
                    CHECK (type IN ('commission','incentive','bonus','penalty','adjustment')),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','paid','cancelled')),
    payout_date     DATE,
    rule_id         TEXT,
    notes           TEXT,
    approved_by     TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_earnings table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pt_os_earnings_trainer_idx  ON pt_os_earnings (trainer_id);
  CREATE INDEX IF NOT EXISTS pt_os_earnings_status_idx   ON pt_os_earnings (status);
  CREATE INDEX IF NOT EXISTS pt_os_earnings_payout_idx   ON pt_os_earnings (payout_date) WHERE status = 'approved';
  CREATE INDEX IF NOT EXISTS pt_os_earnings_type_idx     ON pt_os_earnings (type);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_earnings indexes: %', SQLERRM; END $$;


-- ─── INCENTIVE RULES ───────────────────────────────────────────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_os_incentive_rules (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    name            VARCHAR(100) NOT NULL,
    trigger_type    VARCHAR(50) NOT NULL
                    CHECK (trigger_type IN ('retention','revenue','sessions','rating','adherence','referral','milestone')),
    condition       JSONB       NOT NULL DEFAULT '{}',
    reward_type     VARCHAR(50) NOT NULL
                    CHECK (reward_type IN ('fixed','percentage','tiered')),
    reward_value    DECIMAL(10,2) NOT NULL DEFAULT 0,
    max_per_month   INT,
    description     TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_incentive_rules table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pt_os_incentive_rules_active_idx ON pt_os_incentive_rules (is_active) WHERE is_active = TRUE;
  CREATE INDEX IF NOT EXISTS pt_os_incentive_rules_type_idx  ON pt_os_incentive_rules (trigger_type);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_incentive_rules indexes: %', SQLERRM; END $$;


-- ─── CLIENT MEASUREMENTS (body composition, progress photos) ───
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_os_measurements (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    assignment_id   TEXT        REFERENCES pt_os_assignments(id) ON DELETE SET NULL,
    weight_kg       DECIMAL(5,2),
    body_fat_pct    DECIMAL(4,1),
    chest_cm        DECIMAL(5,2),
    waist_cm        DECIMAL(5,2),
    arms_cm         DECIMAL(5,2),
    thighs_cm       DECIMAL(5,2),
    calves_cm       DECIMAL(5,2),
    shoulders_cm    DECIMAL(5,2),
    neck_cm         DECIMAL(5,2),
    hip_cm          DECIMAL(5,2),
    bmi             DECIMAL(4,1),
    bmr             INT,
    photo_front_url TEXT,
    photo_side_url  TEXT,
    photo_back_url  TEXT,
    notes           TEXT,
    measured_by     TEXT        REFERENCES users(id) ON DELETE SET NULL,
    measured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_measurements table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pt_os_measurements_client_idx ON pt_os_measurements (client_id);
  CREATE INDEX IF NOT EXISTS pt_os_measurements_date_idx   ON pt_os_measurements (measured_at DESC);
  CREATE INDEX IF NOT EXISTS pt_os_measurements_assignment_idx ON pt_os_measurements (assignment_id);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_measurements indexes: %', SQLERRM; END $$;


-- ─── COACHING EVENTS (activity timeline) ───────────────────────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_os_coaching_events (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    trainer_id      TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
    assignment_id   TEXT        REFERENCES pt_os_assignments(id) ON DELETE SET NULL,
    session_id      TEXT        REFERENCES pt_os_sessions(id) ON DELETE SET NULL,
    event_type      VARCHAR(50) NOT NULL
                    CHECK (event_type IN (
                      'workout_completed','meal_uploaded','progress_photo','missed_checkin',
                      'trainer_note','message_sent','goal_updated','measurement_logged',
                      'package_purchased','package_renewed','payment_received',
                      'milestone_achieved','assessment_completed'
                    )),
    title           VARCHAR(200),
    description     TEXT,
    metadata        JSONB       DEFAULT '{}',
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_coaching_events table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pt_os_events_client_idx    ON pt_os_coaching_events (client_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS pt_os_events_trainer_idx   ON pt_os_coaching_events (trainer_id);
  CREATE INDEX IF NOT EXISTS pt_os_events_type_idx      ON pt_os_coaching_events (event_type);
  CREATE INDEX IF NOT EXISTS pt_os_events_assignment_idx ON pt_os_coaching_events (assignment_id);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_coaching_events indexes: %', SQLERRM; END $$;


-- ─── AUTOMATION RULES ──────────────────────────────────────────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_os_automation_rules (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    name            VARCHAR(100) NOT NULL,
    trigger_type    VARCHAR(50) NOT NULL
                    CHECK (trigger_type IN (
                      'inactivity','expiry','overdue','milestone',
                      'goal_reached','attendance_streak','health_score_drop'
                    )),
    trigger_config  JSONB       NOT NULL DEFAULT '{}',
    action_type     VARCHAR(50) NOT NULL
                    CHECK (action_type IN (
                      'whatsapp','email','push','notify_trainer',
                      'flag_client','auto_incentive','create_task'
                    )),
    action_config   JSONB       NOT NULL DEFAULT '{}',
    description     TEXT,
    enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
    last_run_at     TIMESTAMPTZ,
    last_error      TEXT,
    run_count       INT         NOT NULL DEFAULT 0,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_automation_rules table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pt_os_automation_enabled_idx ON pt_os_automation_rules (enabled) WHERE enabled = TRUE;
  CREATE INDEX IF NOT EXISTS pt_os_automation_trigger_idx ON pt_os_automation_rules (trigger_type);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_automation_rules indexes: %', SQLERRM; END $$;


-- ─── AI INSIGHTS ───────────────────────────────────────────────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_os_ai_insights (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        REFERENCES clients(id) ON DELETE CASCADE,
    trainer_id      TEXT        REFERENCES trainers(id) ON DELETE CASCADE,
    assignment_id   TEXT        REFERENCES pt_os_assignments(id) ON DELETE SET NULL,
    insight_type    VARCHAR(50) NOT NULL
                    CHECK (insight_type IN (
                      'churn_risk','upsell','milestone','performance',
                      'bottleneck','schedule_gap','revenue_alert','adherence_drop'
                    )),
    severity        VARCHAR(20) NOT NULL DEFAULT 'medium'
                    CHECK (severity IN ('high','medium','low','positive')),
    title           VARCHAR(200) NOT NULL,
    description     TEXT,
    confidence      INT         CHECK (confidence BETWEEN 0 AND 100),
    metadata        JSONB       DEFAULT '{}',
    suggested_action TEXT,
    action_link     TEXT,
    dismissed       BOOLEAN     NOT NULL DEFAULT FALSE,
    dismissed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_ai_insights table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pt_os_insights_client_active_idx ON pt_os_ai_insights (client_id) WHERE NOT dismissed;
  CREATE INDEX IF NOT EXISTS pt_os_insights_trainer_idx      ON pt_os_ai_insights (trainer_id);
  CREATE INDEX IF NOT EXISTS pt_os_insights_type_severity_idx ON pt_os_ai_insights (insight_type, severity);
  CREATE INDEX IF NOT EXISTS pt_os_insights_created_idx      ON pt_os_ai_insights (created_at DESC);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_ai_insights indexes: %', SQLERRM; END $$;


-- ─── UPDATED_AT TRIGGERS for PT OS tables ──────────────────────
DO $$ DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'pt_os_packages','pt_os_assignments','pt_os_sessions',
    'pt_os_payments','pt_os_earnings','pt_os_incentive_rules',
    'pt_os_automation_rules'
  ])
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


-- ─── HELPER VIEW: active PT assignments ────────────────────────
DO $$ BEGIN
  CREATE OR REPLACE VIEW pt_os_active_assignments AS
  SELECT
    a.id,
    a.client_id,
    c.name      AS client_name,
    c.mobile    AS client_mobile,
    a.trainer_id,
    t.name      AS trainer_name,
    a.package_id,
    p.name      AS package_name,
    p.type      AS package_type,
    a.sessions_total,
    a.sessions_used,
    (a.sessions_total - a.sessions_used) AS sessions_remaining,
    a.start_date,
    a.end_date,
    a.amount,
    a.discount,
    a.final_amount,
    a.health_score,
    a.adherence_pct,
    a.status,
    a.created_at
  FROM pt_os_assignments a
  JOIN clients  c ON c.id = a.client_id
  JOIN trainers t ON t.id = a.trainer_id
  LEFT JOIN pt_os_packages p ON p.id = a.package_id
  WHERE a.status = 'active';
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_active_assignments view: %', SQLERRM; END $$;


-- ─── HELPER VIEW: trainer monthly earnings ─────────────────────
DO $$ BEGIN
  CREATE OR REPLACE VIEW pt_os_trainer_monthly_earnings AS
  SELECT
    e.trainer_id,
    t.name AS trainer_name,
    DATE_TRUNC('month', e.created_at) AS month,
    COUNT(DISTINCT e.id) AS earnings_count,
    SUM(e.amount) FILTER (WHERE e.type = 'commission') AS commission_total,
    SUM(e.amount) FILTER (WHERE e.type = 'incentive') AS incentive_total,
    SUM(e.amount) FILTER (WHERE e.type = 'bonus') AS bonus_total,
    SUM(e.amount) FILTER (WHERE e.type = 'penalty') AS penalty_total,
    SUM(e.amount) AS grand_total,
    COUNT(DISTINCT a.client_id) AS active_clients
  FROM pt_os_earnings e
  JOIN trainers t ON t.id = e.trainer_id
  LEFT JOIN pt_os_assignments a ON a.trainer_id = e.trainer_id AND a.status = 'active'
  GROUP BY e.trainer_id, t.name, DATE_TRUNC('month', e.created_at);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_trainer_monthly_earnings view: %', SQLERRM; END $$;


-- ─── HELPER VIEW: client health snapshot ───────────────────────
DO $$ BEGIN
  CREATE OR REPLACE VIEW pt_os_client_health AS
  SELECT
    a.client_id,
    c.name AS client_name,
    a.id AS assignment_id,
    a.health_score,
    a.adherence_pct,
    a.sessions_total,
    a.sessions_used,
    (a.sessions_total - a.sessions_used) AS sessions_remaining,
    a.end_date,
    CASE
      WHEN a.health_score >= 80 THEN 'excellent'
      WHEN a.health_score >= 60 THEN 'good'
      WHEN a.health_score >= 40 THEN 'fair'
      WHEN a.health_score >= 20 THEN 'poor'
      ELSE 'critical'
    END AS health_label,
    CASE
      WHEN a.end_date IS NOT NULL AND a.end_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'expiring_soon'
      WHEN a.end_date IS NOT NULL AND a.end_date <= CURRENT_DATE THEN 'expired'
      ELSE 'active'
    END AS renewal_status,
    (SELECT COUNT(*) FROM pt_os_sessions s
     WHERE s.assignment_id = a.id AND s.status = 'missed'
       AND s.scheduled_at >= CURRENT_DATE - INTERVAL '30 days') AS missed_last_30d
  FROM pt_os_assignments a
  JOIN clients c ON c.id = a.client_id
  WHERE a.status = 'active';
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'pt_os_client_health view: %', SQLERRM; END $$;
