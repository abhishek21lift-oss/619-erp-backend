'use strict';
// Static review of M2 (message provenance) and M3 (tool-run ledger).
//
// No database is contacted here. These assertions pin the properties that
// cannot be checked by running the app: dependency order, additive shape,
// tenant constraints, append-only grants and the absence of transaction
// control inside a file the runner already wraps.

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

function migration(prefix) {
  const name = fs.readdirSync(MIGRATIONS).find((f) => new RegExp(`^${prefix}_.*\\.sql$`).test(f));
  const sql = name ? fs.readFileSync(path.join(MIGRATIONS, name), 'utf8') : '';
  return {
    name,
    sql,
    executable: sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n'),
  };
}

const m2 = migration('274');
const m3 = migration('275');

const noTransactionControl = (sql) => sql
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => /^(BEGIN|COMMIT|ROLLBACK)\s*(WORK|TRANSACTION)?\s*;$/i.test(l));

describe('migration numbering', () => {
  test('there is exactly one 274 and one 275', () => {
    expect(fs.readdirSync(MIGRATIONS).filter((f) => /^274_/.test(f))).toHaveLength(1);
    expect(fs.readdirSync(MIGRATIONS).filter((f) => /^275_/.test(f))).toHaveLength(1);
    expect(m2.name).toMatch(/^274_ai_message_provenance\.sql$/);
    expect(m3.name).toMatch(/^275_ai_tool_runs\.sql$/);
  });
});

describe('M2 — ai_messages.meta', () => {
  test('adds an idempotent, non-null JSONB column with a constant default', () => {
    expect(m2.sql).toMatch(
      /ALTER TABLE ai_messages\s+ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '\{\}'::jsonb/
    );
  });

  test('documents its dependency on M1 and does not duplicate the tenant', () => {
    expect(m2.sql).toMatch(/273 \(M1\)/);
    expect(m2.executable).not.toMatch(/organization_id/);
    expect(m2.executable).not.toMatch(/archived_at/);
  });

  test('is additive and leaves transaction control to migrate.js', () => {
    expect(m2.executable).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)|TRUNCATE|DELETE\s+FROM/i);
    expect(noTransactionControl(m2.sql)).toEqual([]);
  });
});

describe('M3 — ai_tool_runs', () => {
  test('is written after M1 and M2', () => {
    expect(m3.sql).toMatch(/273 .*→ 274/s);
    expect(m3.sql).toMatch(/M1 must already be applied/);
  });

  test('creates the ledger with tenant, user, conversation and message references', () => {
    expect(m3.sql).toMatch(/CREATE TABLE IF NOT EXISTS ai_tool_runs/);
    expect(m3.sql).toMatch(/organization_id\s+UUID\s+REFERENCES organizations\(id\) ON DELETE CASCADE/);
    expect(m3.sql).toMatch(/user_id\s+TEXT\s+REFERENCES users\(id\) ON DELETE SET NULL/);
    expect(m3.sql).toMatch(/conversation_id\s+TEXT\s+REFERENCES ai_conversations\(id\) ON DELETE SET NULL/);
    expect(m3.sql).toMatch(/message_id\s+TEXT\s+REFERENCES ai_messages\(id\) ON DELETE SET NULL/);
  });

  test('records status, typed error category and correlation', () => {
    expect(m3.sql).toMatch(/correlation_id\s+TEXT\s+NOT NULL/);
    expect(m3.sql).toMatch(/status\s+TEXT\s+NOT NULL CHECK \(status IN \('ok','denied','failed','timeout'\)\)/);
    for (const category of [
      'NO_TOOL_MATCH', 'AUTHORIZATION_DENIED', 'TENANT_SCOPE_DENIED',
      'CLIENT_SCOPE_DENIED', 'ARGUMENT_VALIDATION_FAILED',
      'TOOL_EXECUTION_FAILED', 'TOOL_TIMEOUT',
    ]) {
      expect(m3.sql).toContain(`'${category}'`);
    }
  });

  test('records sanitized input, provenance and bounded result metadata', () => {
    expect(m3.sql).toMatch(/args_digest\s+TEXT\s+NOT NULL/);
    expect(m3.sql).toMatch(/args_meta\s+JSONB\s+CHECK \(args_meta IS NULL OR jsonb_typeof\(args_meta\) = 'object'\)/);
    expect(m3.sql).toMatch(/source\s+TEXT/);
    expect(m3.sql).toMatch(/source_refs\s+JSONB\s+NOT NULL DEFAULT '\[\]'::jsonb/);
    expect(m3.sql).toMatch(/source_as_of\s+TIMESTAMPTZ/);
    expect(m3.sql).toMatch(/freshness\s+JSONB/);
    expect(m3.sql).toMatch(/result_meta\s+JSONB/);
    expect(m3.sql).toMatch(/selection_reason\s+TEXT/);
    expect(m3.sql).toMatch(/duration_ms\s+INTEGER\s+NOT NULL DEFAULT 0 CHECK \(duration_ms >= 0\)/);
  });

  test('a successful row cannot carry an error category', () => {
    expect(m3.sql).toMatch(/status = 'ok' AND error_code IS NULL AND error_category IS NULL/);
    expect(m3.sql).toMatch(/status <> 'ok' AND error_category IS NOT NULL/);
  });

  test('a NULL organization is allowed only for a pre-tenant denial', () => {
    expect(m3.sql).toMatch(
      /organization_id IS NOT NULL\s+OR \(status = 'denied' AND error_category IN \('AUTHORIZATION_DENIED','TENANT_SCOPE_DENIED'\)\)/
    );
  });

  test('run_key is unique, so retries cannot double-write', () => {
    expect(m3.sql).toMatch(/run_key\s+TEXT\s+NOT NULL UNIQUE/);
  });

  test('has the list and correlation indexes', () => {
    expect(m3.sql).toMatch(
      /CREATE INDEX IF NOT EXISTS ai_tool_runs_org_conv_created_idx\s+ON ai_tool_runs \(organization_id, conversation_id, created_at DESC, id DESC\)/
    );
    expect(m3.sql).toMatch(
      /CREATE INDEX IF NOT EXISTS ai_tool_runs_org_user_created_idx\s+ON ai_tool_runs \(organization_id, user_id, created_at DESC, id DESC\)/
    );
    expect(m3.sql).toMatch(/CREATE INDEX IF NOT EXISTS ai_tool_runs_correlation_idx\s+ON ai_tool_runs \(correlation_id\)/);
  });

  test('explicitly revokes the UPDATE/DELETE inherited from migration 157', () => {
    expect(m3.sql).toMatch(/GRANT SELECT, INSERT ON public\.ai_tool_runs TO app_tenant/);
    // 157's default privileges grant all four; the REVOKE is not optional.
    expect(m3.sql).toMatch(/REVOKE UPDATE, DELETE ON public\.ai_tool_runs FROM app_tenant/);
    expect(m3.executable).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)/i);
    expect(m3.executable).not.toMatch(/GRANT ALL/);
  });

  test('RLS scopes the tenant role to its own organization', () => {
    expect(m3.sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(m3.sql).toMatch(/CREATE POLICY deny_all_direct_access ON public\.ai_tool_runs/);
    expect(m3.sql).toMatch(/CREATE POLICY ai_tool_runs_tenant ON public\.ai_tool_runs/);
    expect(m3.sql).toMatch(/organization_id::text = current_setting\('app\.org_id', true\)/);
  });

  test('is additive, backfills nothing and leaves transaction control to migrate.js', () => {
    expect(m3.executable).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)|TRUNCATE|DELETE\s+FROM/i);
    expect(m3.executable).not.toMatch(/UPDATE\s+ai_tool_runs/i);
    expect(noTransactionControl(m3.sql)).toEqual([]);
  });

  test('documents retention, deletion and rollback honestly', () => {
    expect(m3.sql).toMatch(/Retention and deletion/);
    expect(m3.sql).toMatch(/conversation deleted\s+→ conversation_id\/message_id SET NULL/);
    expect(m3.sql).toMatch(/user deleted\s+→ user_id SET NULL/);
    expect(m3.sql).toMatch(/Irreversibly discards the entire audit history/);
  });
});
