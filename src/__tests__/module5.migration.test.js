'use strict';
// 231_module5_progress_habits.sql — the invariants that are easy to lose in a
// later edit and expensive to discover in production.

const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '231_module5_progress_habits.sql'), 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

describe('231_module5_progress_habits.sql', () => {
  it('is read, so nothing below passes vacuously', () => {
    expect(sql.length).toBeGreaterThan(2000);
  });

  it('reuses pt_assessments instead of creating a second assessment table', () => {
    expect(body).toContain('ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS testing_conditions');
    expect(body).not.toMatch(/CREATE TABLE\s+(IF NOT EXISTS\s+)?\w*assessment\w*/i);
  });

  it('has no transaction control — the runner wraps each migration', () => {
    expect(body).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(body).not.toMatch(/^\s*COMMIT\s*;/im);
  });

  it('allows only one open re-test per client and keeps completed history', () => {
    expect(body).toMatch(/CREATE UNIQUE INDEX[^;]*progress_retest_one_open_per_client[\s\S]*?\(client_id\)[\s\S]*?WHERE status IN \('upcoming','due','overdue','rescheduled'\)/i);
    expect(body).toMatch(/status\s+TEXT\s+NOT NULL DEFAULT 'upcoming'/);
    expect(body).toMatch(/'completed'/);
    expect(body).toMatch(/'cancelled'/);
  });

  it('makes reminder delivery idempotent in the schema, not only in the sweep', () => {
    expect(body).toMatch(/UNIQUE \(schedule_id, kind, stage_days, due_date\)/);
  });

  it('backfills the first cycle from the latest assessment and studio cadence', () => {
    const backfill = body.slice(body.indexOf('WITH latest AS'), body.indexOf('-- ── RLS'));
    expect(backfill).toContain('DISTINCT ON (a.client_id)');
    expect(backfill).toMatch(/ORDER BY a\.client_id, a\.assessment_date DESC, a\.created_at DESC/);
    expect(backfill).toContain("COALESCE(s.cadence_months, 4) || ' months'");
    expect(backfill).toContain("'upcoming', 'auto'");
    expect(backfill).toContain('WHERE NOT EXISTS');
  });

  it('puts every new table behind both RLS policies and grants only app_tenant', () => {
    const tables = [
      'progress_retest_settings', 'progress_retest_schedules',
      'progress_reminder_deliveries', 'client_habit_logs',
      'client_habit_preferences', 'progress_insight_reviews',
    ];
    for (const t of tables) expect(body).toContain(`'${t}'`);
    expect(body).toContain('ENABLE ROW LEVEL SECURITY');
    expect(body).toContain('deny_all_direct_access');
    expect(body).toContain('tenant_isolation');
    expect(body).toContain('TO app_tenant');
    expect(body).not.toMatch(/TO\s+(public|anon|authenticated)\b/);
    expect(body).not.toMatch(/GRANT[^;]*TO\s+(anon|authenticated)\b/);
  });

  it('grants the delivery ledger sequence to app_tenant', () => {
    expect(body).toContain('GRANT USAGE, SELECT ON SEQUENCE progress_reminder_deliveries_id_seq TO app_tenant');
  });

  it('is additive — no table drops, truncation or data deletion', () => {
    expect(body).not.toMatch(/\bDROP TABLE\b/i);
    expect(body).not.toMatch(/\bTRUNCATE\b/i);
    expect(body).not.toMatch(/\bDELETE FROM\b/i);
    expect(body).not.toMatch(/\bDROP COLUMN\b/i);
  });
});
