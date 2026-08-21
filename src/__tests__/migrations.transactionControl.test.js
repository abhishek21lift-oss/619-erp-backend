'use strict';
// A migration must not open or close its own transaction.
//
// ── The defect this prevents ───────────────────────────────────────────────
//
// migrate.js already wraps every file:
//
//     BEGIN
//       <the migration>
//       INSERT INTO _migrations (filename) VALUES ($1)
//     COMMIT
//
// so the file's DDL and the bookkeeping row that records it as applied commit
// together, or neither does. A migration that issues its own `COMMIT;` breaks
// that in a way Postgres only mentions in passing:
//
//     WARNING: there is already a transaction in progress   ← its BEGIN
//     WARNING: there is no transaction in progress          ← migrate.js's COMMIT
//
// Between those two lines the migration's own COMMIT has closed migrate.js's
// transaction. The `INSERT INTO _migrations` then runs with no transaction at
// all, and migrate.js's COMMIT is a no-op. So the DDL is committed before the
// row that records it: if the insert fails, the migration has been applied and
// the runner does not know, and it runs again on the next boot.
//
// ── Why it went unnoticed for so long ──────────────────────────────────────
//
// Both warnings are WARNINGs, not errors, and node-postgres discards server
// notices unless something subscribes to them. migrate.js attached no listener
// until PR #81, so every deploy printed a clean "✓ applied" over the top of
// this. The listener went in for migration 174's un-attributable-row report;
// this turned up in the very next migration run, which is the argument for
// listening in the first place.
//
// 170 is grandfathered: it has run everywhere it is ever going to run, and
// editing an applied migration changes nothing about the databases it already
// touched. The point of this test is the next one.

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

/**
 * Migrations that manage their own transaction, with the reason each is
 * tolerated. Not a place to add new entries — a migration needing to control
 * its own transaction (CREATE INDEX CONCURRENTLY, say) needs migrate.js to
 * learn about that case, not a note here.
 */
const GRANDFATHERED = {
  '170_drop_legacy_clients_and_renewals.sql':
    'Applied everywhere before this test existed; its COMMIT closes the runner\'s transaction early, so its _migrations row is written outside one. Editing an applied migration would not change any database that already ran it.',
};

/** Top-level BEGIN/COMMIT/ROLLBACK, not the BEGIN that opens a DO $$ block. */
function transactionStatements(sql) {
  return sql
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /^(BEGIN|COMMIT|ROLLBACK)\s*(WORK|TRANSACTION)?\s*;/i.test(line));
}

describe('migrations leave transaction control to the runner', () => {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

  it('reads a real set of migrations', () => {
    // Guards against a path change silently making every assertion vacuous.
    expect(files.length).toBeGreaterThan(150);
  });

  it('no migration issues its own BEGIN, COMMIT or ROLLBACK', () => {
    const offenders = [];
    for (const f of files) {
      if (GRANDFATHERED[f]) continue;
      const found = transactionStatements(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      if (found.length) {
        offenders.push(`${f}: ${found.map((s) => `L${s.n} ${s.line}`).join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the grandfathered list still describes reality', () => {
    // If someone cleans 170 up, this entry should go with it rather than
    // linger as a note about a problem that no longer exists.
    for (const f of Object.keys(GRANDFATHERED)) {
      const p = path.join(MIGRATIONS, f);
      expect(fs.existsSync(p)).toBe(true);
      expect(transactionStatements(fs.readFileSync(p, 'utf8')).length).toBeGreaterThan(0);
    }
  });

  it('every grandfathered entry gives a reason, not a shrug', () => {
    for (const [f, reason] of Object.entries(GRANDFATHERED)) {
      expect(reason.length).toBeGreaterThan(60);
      expect(f).toMatch(/\.sql$/);
    }
  });

  it('migrate.js is still the thing providing the transaction', () => {
    // The whole rule rests on this. If the runner stops wrapping files, the
    // rule inverts and migrations would need their own transactions.
    const runner = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
    expect(runner).toMatch(/client\.query\(['"]BEGIN['"]\)/);
    expect(runner).toMatch(/client\.query\(['"]COMMIT['"]\)/);
    expect(runner).toMatch(/client\.query\(['"]ROLLBACK['"]\)/);
  });
});
