'use strict';
const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '246_churn_followups.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');

describe('246_churn_followups.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('creates the follow-up table with an org-scoped latest lookup', () => {
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS pt_client_followups/);
    expect(body).toMatch(/organization_id UUID NOT NULL/);
    expect(body).toMatch(/client_id TEXT NOT NULL REFERENCES pt_clients\(id\) ON DELETE CASCADE/);
    expect(body).toMatch(/hide_until DATE NOT NULL/);
    expect(body).toMatch(/risk_score (SMALLINT|INTEGER) NOT NULL/);
    expect(body).toMatch(/CHECK \(outcome IN \('contacted','snoozed'\)\)/);
    expect(body).toMatch(/CHECK \(risk_score BETWEEN 0 AND 100\)/);
    expect(body).toMatch(/ON pt_client_followups \(organization_id, client_id, created_at DESC\)/);
  });

  it('is tenant-scoped like migration 245', () => {
    expect(body.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(1);
    expect(body).toContain("current_setting('app.org_id', true)");
    expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON pt_client_followups TO app_tenant/);
  });

  it('is additive only', () => {
    expect(body).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|ALTER TABLE pt_clients/i);
  });
});
