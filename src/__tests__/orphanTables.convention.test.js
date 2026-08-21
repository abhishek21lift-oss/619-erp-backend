'use strict';
// Every table the application talks to must exist somewhere the repo can see.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// `module_records` backed ModuleWorkspace on eight (chrome) tabs and appeared
// in no migration and no schema file. The route shipped anyway. Nothing in the
// repository could tell you whether the module was wide open or permanently
// broken, because nothing compared "tables the code uses" against "tables the
// schema creates" — the audit had to resolve it with a query against
// production, where the answer turned out to be: the table did not exist, so
// eight tabs had been returning 503 the whole time.
//
// The audit asked for this test by name (Section 11, missing test #5). Writing
// it immediately found two more of the same shape:
//
//   notification_log      INSERTed, exists in production, in no migration
//   pt_os_measurements    read twice, exists in production, in no migration
//
// Both are now created by migration 177. Neither was loud: the notification
// INSERT is wrapped in try/catch that logs "table may not exist yet", and the
// client-portal read carries a comment explaining the author could not verify
// the table's shape from the repo and selected two columns defensively.
//
// ── Why it reads source rather than a database ─────────────────────────────
//
// The same reason as its neighbours: this must fail on the branch, before
// merge, on a machine with no application database. A runtime check only
// discovers the problem once it is someone's incident.
//
// ── What counts as "exists" ────────────────────────────────────────────────
//
// Three legitimate origins, all of which the repo can see:
//   1. CREATE TABLE / CREATE VIEW in schema.sql or a migration
//   2. a table renamed into place by a migration
//   3. CREATE TABLE issued by application code itself (the merge tooling does
//      this deliberately), which must be declared below so it stays a choice

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const MIGRATIONS = path.join(SRC, 'db', 'migrations');

/**
 * Tables the application creates at runtime rather than in a migration.
 *
 * Adding an entry says "this DDL is deliberate", not "quiet the test". Both
 * current entries are created inside a request handler, which is worth
 * knowing: CREATE TABLE takes an ACCESS EXCLUSIVE lock, so a handler that
 * issues one is a handler that can block every reader of that table.
 */
const CREATED_BY_APPLICATION = {
  pt_clients_merge_backup:
    'Snapshot table for the duplicate-client merge tool; CREATE TABLE IF NOT EXISTS in pt-os.routes.js, shaped LIKE pt_clients so a migration cannot express it.',
  pt_clients_merge_log:
    'Audit trail for the same merge tool, created alongside its backup table in the same handler.',
};

/** Relations any migration or the base schema brings into existence. */
function schemaRelations() {
  const names = new Set();
  const sources = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(MIGRATIONS, f));

  const base = path.join(SRC, 'db', 'schema.sql');
  if (fs.existsSync(base)) sources.unshift(base);

  for (const p of sources) {
    const sql = fs.readFileSync(p, 'utf8').replace(/--[^\n]*/g, ' ');
    const patterns = [
      /CREATE\s+(?:UNLOGGED\s+|TEMP\w*\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-z0-9_]+)/gi,
      /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-z0-9_]+)/gi,
      /RENAME\s+TO\s+["']?([a-z0-9_]+)/gi,
    ];
    for (const re of patterns) {
      for (const m of sql.matchAll(re)) names.add(m[1].toLowerCase());
    }
  }
  return names;
}

/** Strip JS comments so English prose cannot be mistaken for SQL. */
function stripJsComments(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Table names referenced by SQL in application code.
 *
 * Only looks inside string literals that actually contain SQL, and strips SQL
 * line comments inside them — a first draft of this scanned whole files and
 * reported 181 "tables", almost all of them ordinary English words following
 * "from" or "into" in a comment.
 */
function referencedTables() {
  const found = new Map();
  // Must look like an actual statement, not merely contain a SQL-ish word.
  // A looser test matched ordinary strings — 'Cannot update a paid invoice'
  // and 'last_login update failed (non-critical)' both registered as queries
  // and contributed the "tables" `a` and `failed`.
  const SQL_ISH = new RegExp(
    [
      'SELECT[\\s\\S]+?\\sFROM\\s',
      'INSERT\\s+INTO\\s',
      'UPDATE\\s+[a-z_][a-z0-9_]*\\s+SET\\s',
      'DELETE\\s+FROM\\s',
      'WITH\\s+[a-z_][a-z0-9_]*\\s+AS\\s*\\(',
    ].join('|'),
    'i'
  );

  // Keywords and functions that can follow FROM/JOIN without naming a table.
  const NOT_A_TABLE = new Set([
    'lateral', 'unnest', 'generate_series', 'jsonb_array_elements',
    'jsonb_array_elements_text', 'json_array_elements', 'regexp_split_to_table',
    'jsonb_to_recordset',
    'only', 'select', 'set',
  ]);

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'db') continue;
        walk(p);
      } else if (entry.name.endsWith('.js')) {
        const src = stripJsComments(fs.readFileSync(p, 'utf8'));
        const literals = [
          ...[...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]),
          ...[...src.matchAll(/'([^'\n]{20,})'/g)].map((m) => m[1]),
        ];

        // CTE names are collected per FILE, not per literal: a query assembled
        // from fragments can define `WITH candidates AS (…)` in one string and
        // read `FROM candidates` in another.
        const fileCtes = new Set(
          [...src.matchAll(/\b([a-z0-9_]+)\s+AS\s*\(/gi)].map((m) => m[1].toLowerCase())
        );

        for (const raw of literals) {
          if (!SQL_ISH.test(raw)) continue;
          const lit = raw
            .replace(/--[^\n]*/g, ' ')
            // EXTRACT(YEAR FROM age(...)) and SUBSTRING(x FROM y) use FROM as
            // syntax, not as a table reference.
            .replace(/\bEXTRACT\s*\([^)]*\)/gi, ' ')
            .replace(/\bSUBSTRING\s*\([^)]*\)/gi, ' ')
            // ON CONFLICT … DO UPDATE SET <col> is an assignment list.
            .replace(/\bDO\s+UPDATE\s+SET\b/gi, ' ')
            // `FOR UPDATE OF b` is row-locking syntax; "UPDATE OF" otherwise
            // reads as an update of a table called "of".
            .replace(/\bFOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)(?:\s+OF\s+[a-z0-9_,\s]+)?/gi, ' ');

          for (const m of lit.matchAll(
            // No lookahead for "(" here. An earlier draft used one to skip
            // function calls, and it silently truncated every name in
            // `INSERT INTO activity_log (user_id, …)` by one character —
            // the regex backtracked to satisfy it. Functions are excluded by
            // stripping EXTRACT/SUBSTRING above and by NOT_A_TABLE instead.
            /\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?["']?([a-z][a-z0-9_]*)\b/gi
          )) {
            const t = m[1].toLowerCase();
            if (fileCtes.has(t) || NOT_A_TABLE.has(t)) continue;
            if (/^(pg_|information_schema)/.test(t)) continue;
            if (!found.has(t)) found.set(t, p.replace(`${SRC}/`, 'src/'));
          }
        }
      }
    }
  };

  walk(SRC);
  return found;
}

describe('every table the application uses exists in the schema', () => {
  const schema = schemaRelations();
  const referenced = referencedTables();

  it('finds a substantial schema and a substantial set of references', () => {
    // A scanner that silently matched nothing would make every assertion below
    // vacuously true, which is the failure mode of source-reading tests.
    expect(schema.size).toBeGreaterThan(100);
    expect(referenced.size).toBeGreaterThan(100);
  });

  it('no table is referenced that nothing in the repo creates', () => {
    const orphans = [];
    for (const [table, where] of referenced) {
      if (schema.has(table)) continue;
      if (CREATED_BY_APPLICATION[table]) continue;
      orphans.push(`${table} (first seen in ${where})`);
    }
    // module_records, notification_log and pt_os_measurements each sat here.
    expect(orphans.sort()).toEqual([]);
  });

  it('the two tables migration 177 rescued are now visible to the schema', () => {
    // Pins the fix, so deleting 177 fails here rather than only in production
    // months later on the next fresh install.
    expect(schema.has('notification_log')).toBe(true);
    expect(schema.has('pt_os_measurements')).toBe(true);
    expect(schema.has('module_records')).toBe(true);
  });

  it('every application-created table has a written reason', () => {
    for (const [table, reason] of Object.entries(CREATED_BY_APPLICATION)) {
      expect(`${table}: ${reason}`.length).toBeGreaterThan(table.length + 40);
    }
  });

  it('the application-created list only holds tables the code really creates', () => {
    // An entry here is an exemption from the check above, so it must be
    // earned: the repo has to contain DDL for it.
    const all = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); }
        else if (e.name.endsWith('.js')) all.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(SRC);
    const body = all.join('\n');
    for (const table of Object.keys(CREATED_BY_APPLICATION)) {
      expect(body).toMatch(new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, 'i'));
    }
  });
});
