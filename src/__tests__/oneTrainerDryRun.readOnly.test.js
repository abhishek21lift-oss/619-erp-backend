'use strict';
/**
 * The dry run is invited to be pointed at production, so it has to earn that.
 *
 * A script that only reports is worth nothing if nobody checked that it only
 * reports. This reads the source and refuses any statement that could write —
 * which is a weaker guarantee than a read-only database role, and the right one
 * here, because the operator running it will not have provisioned a special
 * role first.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'scripts', 'one-trainer-dry-run.js'), 'utf8');

/** The SQL twin, for pasting into the Supabase editor when node is inconvenient. */
const SQL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'scripts', 'one-trainer-dry-run.sql'), 'utf8');

/** SQL with comments stripped — the prose names the DDL it avoids. */
const SQL_CODE = SQL
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

/** Source with comments stripped — prose explains the DDL it avoids. */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

describe('one-trainer-dry-run is read-only', () => {
  it.each([
    ['INSERT', /\bINSERT\s+INTO\b/i],
    ['UPDATE', /\bUPDATE\s+\w/i],
    ['DELETE', /\bDELETE\s+FROM\b/i],
    ['TRUNCATE', /\bTRUNCATE\b/i],
    ['DROP', /\bDROP\s+(TABLE|INDEX|COLUMN|CONSTRAINT|POLICY)\b/i],
    ['ALTER', /\bALTER\s+(TABLE|ROLE|INDEX)\b/i],
    ['CREATE', /\bCREATE\s+(TABLE|INDEX|UNIQUE|POLICY|ROLE|FUNCTION)\b/i],
    ['GRANT/REVOKE', /\b(GRANT|REVOKE)\b/i],
    ['set_config', /set_config\s*\(/i],
    ['SELECT … INTO', /\bSELECT\b[\s\S]{0,400}?\bINTO\s+\w/i],
  ])('contains no %s', (_label, pattern) => {
    expect(CODE).not.toMatch(pattern);
  });

  it('opens its own pool rather than importing db/pool', () => {
    // db/pool starts a connection test and patches query/connect on require.
    // A reporting script should not have side effects just by being loaded, and
    // must not be routed by the tenant wrapper.
    expect(CODE).not.toMatch(/require\(['"].*db\/pool['"]\)/);
    expect(CODE).toContain("require('pg')");
  });

  it('prefers ADMIN_DATABASE_URL, because the tenant role would report nothing', () => {
    // After the RLS cutover DATABASE_URL authenticates as app_tenant, which
    // sees one studio at most — and RLS filters rather than errors, so an empty
    // cross-studio report would read as "no surplus trainers anywhere".
    expect(CODE).toMatch(/process\.env\.ADMIN_DATABASE_URL \|\| process\.env\.DATABASE_URL/);
  });

  it('reports the role it connected as, and warns when that role cannot see across studios', () => {
    expect(CODE).toContain('current_user');
    expect(CODE).toContain('rolbypassrls');
    expect(CODE).toMatch(/bypassrls/);
  });

  it('discovers the status vocabulary instead of trusting the draft predicate', () => {
    // The whole point of §6: status='scheduled' was an assumption. If the data
    // disagrees, the report has to show it rather than filter it away.
    expect(CODE).toMatch(/GROUP BY status/);
    expect(CODE).toContain('status_vocabulary');
  });

  it('reports what it deliberately leaves alone', () => {
    expect(CODE).toContain('deliberately_untouched');
    expect(CODE).toContain('leave_requests');
  });

  it('exits non-zero when a studio needs a human first', () => {
    // No active trainer means nothing can survive; more than one owner is the
    // other shape that has to be looked at before a migration is written.
    expect(CODE).toMatch(/noTrainer \|\| manyOwners \? 1 : 0/);
  });

  describe('and so is the SQL twin', () => {
    it.each([
      ['INSERT', /\bINSERT\s+INTO\b/i],
      ['UPDATE', /\bUPDATE\s+\w/i],
      ['DELETE', /\bDELETE\s+FROM\b/i],
      ['TRUNCATE', /\bTRUNCATE\b/i],
      ['DROP', /\bDROP\s+(TABLE|INDEX|COLUMN|CONSTRAINT|POLICY)\b/i],
      ['ALTER', /\bALTER\s+(TABLE|ROLE|INDEX)\b/i],
      ['CREATE TABLE/INDEX', /\bCREATE\s+(TABLE|INDEX|UNIQUE|POLICY|ROLE)\b/i],
      ['GRANT/REVOKE', /\b(GRANT|REVOKE)\b/i],
      ['set_config', /set_config\s*\(/i],
      ['SELECT … INTO a table', /\bSELECT\b[^;]{0,400}?\bINTO\s+(TEMP|TEMPORARY|UNLOGGED)\b/i],
    ])('contains no %s', (_label, pattern) => {
      expect(SQL_CODE).not.toMatch(pattern);
    });

    it('probes for missing tables instead of assuming the repo built them', () => {
      // Production has drifted: it carries pt_os_* and memberships tables this
      // repository does not build. Naming a missing table in plain SQL is a
      // parse error, so every table goes through to_regclass first.
      expect(SQL_CODE).toContain('to_regclass');
      expect(SQL_CODE).toMatch(/table absent/);
    });

    it('carries the same future-booking predicates as the JS version', () => {
      // Two files, one decision. If these drift, one of them is moving dead
      // bookings onto the surviving trainer.
      for (const pred of [
        "status = 'scheduled' AND x.session_date >= CURRENT_DATE",
        "status IN ('NOT_STARTED','IN_PROGRESS')",
      ]) {
        expect(SQL_CODE.replace(/''/g, "'")).toContain(pred);
        expect(CODE).toContain(pred);
      }
    });

    it('checksums protected history, not just counts', () => {
      // A same-count substitution passes a count comparison. It does not pass
      // a checksum over (trainer_id, count) groupings.
      expect(SQL_CODE).toContain('md5(string_agg(');
    });
  });
});
