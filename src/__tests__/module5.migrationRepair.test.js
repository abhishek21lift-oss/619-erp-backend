'use strict';
// 233_module5_reminder_recipient_repair.sql — forward repair for databases
// that recorded the earlier, four-column draft of 231.

const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '233_module5_reminder_recipient_repair.sql'), 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

describe('233_module5_reminder_recipient_repair.sql', () => {
  it('is read, so nothing below passes vacuously', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('adds the recipient idempotently', () => {
    expect(body).toMatch(/ADD COLUMN IF NOT EXISTS recipient TEXT NOT NULL DEFAULT 'client'/);
  });

  it('drops the earlier four-column key by shape, not by name', () => {
    expect(body).toMatch(/FROM pg_constraint[\s\S]*contype = 'u'/);
    expect(body).toContain('unnest(conkey)');
    expect(body).toContain('unnest(i.indkey::smallint[])');
    expect(body).toContain('DROP CONSTRAINT');
    expect(body).toContain('DROP INDEX');
  });

  it('recreates the recipient check and five-column unique key', () => {
    expect(body).toContain("CHECK (recipient IN ('client','trainer'))");
    expect(body).toMatch(/CREATE UNIQUE INDEX[^;]*progress_reminder_delivery_recipient_key[\s\S]*?\(schedule_id, kind, stage_days, due_date, recipient\)/i);
    // Dropped first so a wrong-shaped index cannot survive IF NOT EXISTS.
    expect(body).toMatch(/DROP INDEX IF EXISTS public\.progress_reminder_delivery_recipient_key[\s\S]*CREATE UNIQUE INDEX/);
  });

  it('has no transaction control — the runner wraps each migration', () => {
    expect(body).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(body).not.toMatch(/^\s*COMMIT\s*;/im);
  });

  it('does not drop tables, columns, truncate, or delete rows', () => {
    expect(body).not.toMatch(/\bDROP TABLE\b/i);
    expect(body).not.toMatch(/\bDROP COLUMN\b/i);
    expect(body).not.toMatch(/\bTRUNCATE\b/i);
    expect(body).not.toMatch(/\bDELETE FROM\b/i);
  });
});
