'use strict';

// 267 is additive: one feedback row per session, plus the completion stamp on
// pt_sessions. The shape checks hold the properties the rest of the feature
// relies on — one row per session at the database, a submitted row that cannot
// exist without answers and a score, and tenant isolation.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '267_session_feedback.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');

describe('267_session_feedback.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(1000);
  });

  it('stamps the completion moment on the session', () => {
    expect(body).toMatch(/ALTER TABLE pt_sessions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ/);
  });

  it('creates one feedback request per session', () => {
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS pt_session_feedback/);
    expect(body).toMatch(/session_id TEXT NOT NULL REFERENCES pt_sessions\(id\) ON DELETE CASCADE/);
    expect(body).toMatch(/UNIQUE \(session_id\)/);
  });

  it('keeps a pending row answerless and a submitted row complete', () => {
    expect(body).toMatch(/status TEXT NOT NULL DEFAULT 'pending' CHECK \(status IN \('pending','submitted'\)\)/);
    for (const option of ['excellent', 'good', 'average', 'poor']) expect(body).toContain(`'${option}'`);
    for (const option of ['always', 'mostly', 'sometimes', 'no']) expect(body).toContain(`'${option}'`);
    for (const option of ['perfect', 'too_easy', 'too_hard']) expect(body).toContain(`'${option}'`);
    for (const option of ['absolutely', 'somewhat', 'not_really']) expect(body).toContain(`'${option}'`);
    expect(body).toMatch(/overall_stars SMALLINT CHECK \(overall_stars BETWEEN 1 AND 5\)/);
    expect(body).toMatch(/score NUMERIC\(4,2\) CHECK \(score >= 0 AND score <= 5\)/);
    expect(body).toMatch(/status = 'submitted' AND trainer_behaviour IS NOT NULL/);
    expect(body).toMatch(/status = 'pending' AND trainer_behaviour IS NULL/);
  });

  it('scopes the table to the request organization', () => {
    expect(body).toMatch(/organization_id UUID NOT NULL/);
    expect(body).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(body).toMatch(/current_setting\('app\.org_id', true\)/);
    expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON pt_session_feedback TO app_tenant/);
  });

  it('is additive only', () => {
    expect(body).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|ALTER TABLE pt_clients|ALTER TABLE pt_sessions[^;]*DROP/i);
  });
});
