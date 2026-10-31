-- 245_client_self_booking.sql
--
-- Phase 1 of the PT OS expansion: the trainer publishes weekly availability,
-- the client books inside it, and the reminders fire without anybody pressing
-- a button.
--
-- ── Why slots are not stored ────────────────────────────────────────────────
--
-- Free slots are derived at read time from availability minus the sessions
-- that already exist. A slot table would need a generator, a refresh job and a
-- clean-up pass every time a session moved outside the app, and every one of
-- those is a way for the inventory to disagree with the calendar. The only
-- stored fact here is the trainer's intent (windows, time off, settings).
--
-- ── The one hard guarantee ──────────────────────────────────────────────────
--
-- Two requests can compute the same free slot at the same moment — a double
-- tap, two tabs, a retried POST. The partial unique index below is what makes
-- the second insert fail instead of producing two sessions in one hour. It is
-- partial because cancelled and soft-deleted rows must not hold a slot, and
-- because historical rows predate `start_time`.
--
-- The block before the index refuses to apply while duplicates exist: silently
-- keeping one of two real bookings is worse than a failed deploy a human then
-- resolves.

-- ── Weekly availability ─────────────────────────────────────────────────────
-- weekday is 0 = Sunday, matching JavaScript's getUTCDay(). A trainer may
-- publish several windows per day (a morning and an evening split).

CREATE TABLE IF NOT EXISTS trainer_availability (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id UUID NOT NULL,
  trainer_id      TEXT NOT NULL,
  weekday         SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time      TIME NOT NULL,
  end_time        TIME NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trainer_availability_window CHECK (start_time < end_time),
  CONSTRAINT trainer_availability_unique UNIQUE (trainer_id, weekday, start_time)
);

CREATE INDEX IF NOT EXISTS trainer_availability_lookup
  ON trainer_availability (organization_id, trainer_id, weekday);

-- ── Time off ────────────────────────────────────────────────────────────────
-- Inclusive date range. A holiday is a day, not a timestamp; sessions are
-- stored as wall-clock dates, so this is the same unit.

CREATE TABLE IF NOT EXISTS trainer_time_off (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id UUID NOT NULL,
  trainer_id      TEXT NOT NULL,
  starts_on       DATE NOT NULL,
  ends_on         DATE NOT NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trainer_time_off_range CHECK (starts_on <= ends_on)
);

CREATE INDEX IF NOT EXISTS trainer_time_off_lookup
  ON trainer_time_off (organization_id, trainer_id, starts_on, ends_on);

-- ── Booking settings ────────────────────────────────────────────────────────
-- One row per trainer. Missing row means the column defaults apply; the row is
-- created when the trainer first saves settings (which is also when the ICS
-- token is minted, so a feed URL is stable for the life of the setting).

CREATE TABLE IF NOT EXISTS trainer_booking_settings (
  organization_id     UUID NOT NULL,
  trainer_id          TEXT NOT NULL,
  slot_minutes        INT NOT NULL DEFAULT 60 CHECK (slot_minutes BETWEEN 15 AND 240),
  buffer_minutes      INT NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 60),
  min_notice_hours    INT NOT NULL DEFAULT 12 CHECK (min_notice_hours BETWEEN 0 AND 168),
  horizon_days        INT NOT NULL DEFAULT 30 CHECK (horizon_days BETWEEN 1 AND 90),
  cancel_cutoff_hours INT NOT NULL DEFAULT 12 CHECK (cancel_cutoff_hours BETWEEN 0 AND 168),
  ics_token           TEXT NOT NULL UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, trainer_id)
);

-- ── One scheduled session per trainer-slot ─────────────────────────────────

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM pt_sessions
     WHERE deleted_at IS NULL AND status = 'scheduled' AND start_time IS NOT NULL
     GROUP BY trainer_id, session_date, start_time HAVING count(*) > 1
  ) d;
  IF n > 0 THEN RAISE EXCEPTION '245: % duplicate scheduled slot(s); resolve before applying', n; END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS pt_sessions_trainer_slot_uniq
  ON pt_sessions (trainer_id, session_date, start_time)
  WHERE deleted_at IS NULL AND status = 'scheduled' AND start_time IS NOT NULL;

-- ── Reminder trigger event ──────────────────────────────────────────────────
-- The engine's TRIGGER_EVENTS list and this CHECK are asserted equal by
-- src/__tests__/automation.engine.test.js. Bump both, or neither.

ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS automation_rules_trigger_event_check;
ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_trigger_event_check
  CHECK (trigger_event IN (
    'member_created', 'lead_created', 'followup_due', 'membership_expiring',
    'membership_expired', 'payment_received', 'session_low', 'birthday',
    'anniversary', 'attendance_missed', 'trial_scheduled', 'trial_completed',
    'payment_due', 'session_reminder'
  ));

-- ── Tenant isolation ────────────────────────────────────────────────────────
-- Same shape as migration 227. pt_sessions itself predates this policy layer;
-- new tables do not get to inherit that gap.

ALTER TABLE trainer_availability ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trainer_availability FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON trainer_availability;
CREATE POLICY deny_all_direct_access ON trainer_availability
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON trainer_availability;
CREATE POLICY tenant_isolation ON trainer_availability FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON trainer_availability TO app_tenant;

ALTER TABLE trainer_time_off ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trainer_time_off FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON trainer_time_off;
CREATE POLICY deny_all_direct_access ON trainer_time_off
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON trainer_time_off;
CREATE POLICY tenant_isolation ON trainer_time_off FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON trainer_time_off TO app_tenant;

ALTER TABLE trainer_booking_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trainer_booking_settings FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON trainer_booking_settings;
CREATE POLICY deny_all_direct_access ON trainer_booking_settings
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON trainer_booking_settings;
CREATE POLICY tenant_isolation ON trainer_booking_settings FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON trainer_booking_settings TO app_tenant;

COMMENT ON TABLE trainer_availability IS
  'Weekly bookable windows per trainer (migration 245). Slots are computed, never stored.';
COMMENT ON TABLE trainer_time_off IS
  'Inclusive date ranges the trainer is unavailable (migration 245).';
COMMENT ON TABLE trainer_booking_settings IS
  'Slot length, notice, horizon and cancellation cutoff per trainer; ics_token powers the public feed (migration 245).';
