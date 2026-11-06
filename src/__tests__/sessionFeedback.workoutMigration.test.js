'use strict';

// 268 makes pt_session_feedback dual-source. The exactly-one check is the
// property the rest of the feature relies on: a feedback row always names the
// session it belongs to, and never two. Existing rows are all session-backed,
// so the migration is additive and needs no data rewrite.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '268_workout_session_feedback.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');

describe('268_workout_session_feedback.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('links a request to a workout session, with the session cascade', () => {
    expect(body).toMatch(/ADD COLUMN IF NOT EXISTS workout_session_id TEXT REFERENCES workout_sessions\(id\) ON DELETE CASCADE/);
  });

  it('makes session_id nullable so workout-backed rows are valid', () => {
    expect(body).toMatch(/ALTER COLUMN session_id DROP NOT NULL/);
  });

  it('requires exactly one source row', () => {
    expect(body).toMatch(/CHECK \(\(session_id IS NOT NULL\) <> \(workout_session_id IS NOT NULL\)\)/);
  });

  it('allows one request per workout session', () => {
    expect(body).toMatch(/UNIQUE \(workout_session_id\)/);
  });

  it('is additive only', () => {
    expect(body).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|ALTER TABLE pt_clients/i);
  });
});
