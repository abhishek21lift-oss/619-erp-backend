'use strict';

// 248 is the first migration with a child table, so the shape check has two
// things to hold: both tables are tenant-scoped, and deleting a check takes
// its comments with it. Without the cascade, deleting a client would fail on
// the comments or leave them pointing at a row that no longer exists.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '248_form_checks.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');

describe('248_form_checks.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(1000);
  });

  it('creates the video table, owned by a client in an organization', () => {
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS pt_form_checks/);
    expect(body).toMatch(/organization_id UUID NOT NULL/);
    expect(body).toMatch(/client_id TEXT NOT NULL REFERENCES pt_clients\(id\) ON DELETE CASCADE/);
    expect(body).toMatch(/exercise TEXT NOT NULL/);
    expect(body).toMatch(/video_url TEXT NOT NULL/);
    expect(body).toMatch(/CHECK \(status IN \('pending','reviewed'\)\)/);
  });

  it('creates timestamped comments that die with their check', () => {
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS pt_form_check_comments/);
    expect(body).toMatch(/form_check_id TEXT NOT NULL REFERENCES pt_form_checks\(id\) ON DELETE CASCADE/);
    expect(body).toMatch(/at_seconds INTEGER NOT NULL CHECK \(at_seconds >= 0\)/);
    expect(body).toMatch(/body TEXT NOT NULL/);
    // Read in video order, so the member hears the notes in the order they watch.
    expect(body).toMatch(/ON pt_form_check_comments \(form_check_id, at_seconds, created_at\)/);
  });

  it('scopes both tables to the request organization', () => {
    expect(body.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(body.match(/current_setting\('app\.org_id', true\)/g)).toHaveLength(4);
    expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON pt_form_checks TO app_tenant/);
    expect(body).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON pt_form_check_comments TO app_tenant/);
  });

  it('is additive only', () => {
    expect(body).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|ALTER TABLE pt_clients/i);
  });
});
