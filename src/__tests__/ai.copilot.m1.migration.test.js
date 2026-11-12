'use strict';
// Migration M1: conversation tenancy, archive and context.
//
// The production schema was inspected before this was written: 93
// ai_conversations rows, no organization_id/archived_at/context, RLS already
// enabled with a tenant_isolation policy that reaches the org through
// users.organization_id. This migration is additive and backfills from the
// same join, so a row whose user has no org stays NULL and is never returned
// to a tenant caller.

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const FILE = fs.readdirSync(MIGRATIONS).find((f) => /^273_.*\.sql$/.test(f));
const SQL = FILE ? fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8') : '';
/** SQL with line comments removed, so a documented rollback is not executable. */
const EXECUTABLE = SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('M1 migration exists and is named in sequence', () => {
  test('there is exactly one 273 migration', () => {
    expect(fs.readdirSync(MIGRATIONS).filter((f) => /^273_/.test(f))).toHaveLength(1);
    expect(FILE).toMatch(/^273_[a-z0-9_]+\.sql$/);
  });
});

describe('M1 adds the three columns without rewriting existing rows', () => {
  test('organization_id is nullable with an org foreign key', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations\(id\) ON DELETE CASCADE/);
  });

  test('archived_at is nullable', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/);
  });

  test('context has a non-null default, so existing rows need no update', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS context JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  });

  test('no column is dropped, truncated or deleted', () => {
    expect(EXECUTABLE).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i);
    expect(EXECUTABLE).not.toMatch(/TRUNCATE|DELETE\s+FROM/i);
  });

  test('it leaves transaction control to migrate.js', () => {
    const topLevel = SQL
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(BEGIN|COMMIT|ROLLBACK)\s*(WORK|TRANSACTION)?\s*;$/i.test(l));
    expect(topLevel).toEqual([]);
  });
});

describe('M1 backfills tenancy from the authenticated user', () => {
  test('backfill is a single set-based update through users', () => {
    expect(SQL).toMatch(/UPDATE ai_conversations c/);
    expect(SQL).toMatch(/SET organization_id = u\.organization_id/);
    expect(SQL).toMatch(/FROM users u/);
    expect(SQL).toMatch(/WHERE c\.user_id = u\.id/);
  });

  test('only unset rows are touched, so a re-run is idempotent', () => {
    expect(SQL).toMatch(/c\.organization_id IS NULL/);
    expect(SQL).toMatch(/u\.organization_id IS NOT NULL/);
  });
});

describe('M1 adds the conversation lookup index', () => {
  test('the index matches the list query shape', () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS ai_conversations_org_user_updated_idx\s+ON ai_conversations \(organization_id, user_id, updated_at DESC\)/
    );
  });
});
