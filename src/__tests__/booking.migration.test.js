'use strict';
// 245_client_self_booking.sql — availability, time off, booking settings, and
// the two constraints booking correctness depends on: one scheduled session per
// trainer-slot, and the automation trigger that carries reminders.
//
// Pinned as static SQL, like activityLogOrgId.migration.test.js: the migration
// runner is not part of this suite, so the file itself is the contract.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '245_client_self_booking.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
// Comments stripped and whitespace collapsed: column alignment in the SQL is
// not a fact this test is pinning, so it must not decide pass or fail.
const body = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');

describe('245_client_self_booking.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('creates the three tables and the slot index', () => {
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS trainer_availability/);
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS trainer_time_off/);
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS trainer_booking_settings/);
    expect(body).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS pt_sessions_trainer_slot_uniq\s+ON pt_sessions \(trainer_id, session_date, start_time\)\s+WHERE deleted_at IS NULL AND status = 'scheduled' AND start_time IS NOT NULL/);
  });

  it('fails loudly on a pre-existing duplicate instead of deleting rows', () => {
    expect(body).toMatch(/RAISE EXCEPTION '245: % duplicate scheduled slot/);
    expect(body).not.toMatch(/DELETE FROM pt_sessions/i);
  });

  it('adds session_reminder to the trigger CHECK without dropping data', () => {
    expect(body).toContain("'session_reminder'");
    expect(body).toMatch(/DROP CONSTRAINT IF EXISTS automation_rules_trigger_event_check/);
    expect(body).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/i);
  });

  it('is tenant-scoped like migration 227', () => {
    expect(body.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(3);
    expect(body).toContain("current_setting('app.org_id', true)");
    expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON trainer_availability TO app_tenant/);
    expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON trainer_time_off TO app_tenant/);
    expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON trainer_booking_settings TO app_tenant/);
  });

  it('pins windows, ranges and settings defaults the service relies on', () => {
    expect(body).toMatch(/weekday smallint not null check \(weekday between 0 and 6\)/i);
    expect(body).toMatch(/check \(start_time < end_time\)/i);
    expect(body).toMatch(/check \(starts_on <= ends_on\)/i);
    expect(body).toMatch(/slot_minutes int not null default 60/i);
    expect(body).toMatch(/ics_token text not null unique/i);
  });
});
