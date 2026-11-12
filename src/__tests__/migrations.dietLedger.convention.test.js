'use strict';
// Migration 281 is read, not run: the ledger's keys and its single tenant
// policy must be right before a database sees them.

const fs = require('fs');
const path = require('path');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '281_ai_diet_generations.sql'),
  'utf8',
);

test('creates the ledger with its links to the client and the accepted plan', () => {
  expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS ai_diet_generations/);
  expect(SQL).toMatch(/client_id\s+TEXT NOT NULL REFERENCES pt_clients\(id\)/);
  expect(SQL).toMatch(/proposed_plan\s+JSONB NOT NULL/);
  expect(SQL).toMatch(/accepted_template_id\s+TEXT REFERENCES diet_templates\(id\)/);
});

test('denies direct access and isolates the studio', () => {
  const deny = (SQL.match(/CREATE POLICY deny_all_direct_access[\s\S]*?;/) || [''])[0];
  expect(deny).toContain('USING (false)');

  const tenant = (SQL.match(/CREATE POLICY tenant_isolation[\s\S]*?;/) || [''])[0];
  expect(tenant).toContain('TO app_tenant');
  expect(tenant).toContain("organization_id::text = current_setting('app.org_id', true)");
});

test('grants app_tenant what the repository uses', () => {
  expect(SQL).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON ai_diet_generations TO app_tenant/);
});

test('leaves transaction control to the runner', () => {
  expect(SQL).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
});
