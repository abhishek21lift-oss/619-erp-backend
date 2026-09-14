'use strict';

// One ordering for "which programme is this client on", enforced against the
// source rather than against a reviewer's memory.
//
// ── What went wrong without it ─────────────────────────────────────────────
//
// `workout_assignments` is UNIQUE on (workout_plan_id, client_id, status), so
// a client may hold several rows with status 'active' at once — four of this
// studio's clients do. Four separate readers each picked one, and each wrote
// its own ORDER BY:
//
//   · pt-os.routes.js       ORDER BY wa.start_date DESC LIMIT 1
//   · workout-log.routes.js ORDER BY wa.start_date DESC LIMIT 1   (twice)
//   · routes/ai.js          ORDER BY wa.created_at DESC LIMIT 3
//   · pt-os.service.js      ORDER BY (prescribes today) DESC, a.start_date DESC
//   · routes/workouts.js    no ORDER BY at all
//
// `start_date` is a DATE. Two assignments starting the same Monday are TIED,
// and PostgreSQL is free to return either first — so the analytics screen, the
// session log and the generator could each answer a different question about
// the same client on the same afternoon, with nothing anywhere saying a choice
// had been made.
//
// assignments.js exports the one total order. This test is what stops the
// fifth reader from quietly inventing a sixth.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/** Every .js under src, excluding the tests themselves. */
function sourceFiles(dir = SRC) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles();

/**
 * Statements that select from workout_assignments and keep only ONE row.
 *
 * `LIMIT 1` is the marker, because that is what makes an ordering load-bearing:
 * a listing endpoint that returns every assignment in created order is answering
 * a different question and is deliberately not covered. So is the
 * `length === 1 ? ... : null` in workout-log's session-create path, which
 * refuses to choose rather than choosing badly — the behaviour this rule wants.
 */
function pickOneStatements(src) {
  // ── Comments are stripped FIRST ────────────────────────────────────────
  //
  // These queries are heavily commented, and the Today roster's comment
  // explains itself with the words "so this LIMIT 1 was choosing between
  // them on recency". A scan that read that as the statement's LIMIT matched
  // a fragment ending before the real ORDER BY and reported a reader with no
  // ordering at all — a false failure that would have been "fixed" by
  // loosening the rule, which is the worst possible outcome for a convention
  // test. Two `-` characters cannot appear in this SQL except as a comment.
  const code = src.replace(/--[^\n]*/g, '');

  const out = [];
  // Template literals and plain strings both; the SQL is written inline in
  // every reader. A statement runs from FROM workout_assignments to its LIMIT.
  const re = /FROM\s+workout_assignments[\s\S]{0,1200}?LIMIT\s+1/gi;
  let m;
  while ((m = re.exec(code)) !== null) out.push(m[0]);
  return out;
}

describe('picking one active assignment', () => {
  const readers = FILES
    .map((file) => ({ file, src: fs.readFileSync(file, 'utf8') }))
    .flatMap(({ file, src }) => pickOneStatements(src)
      .filter((sql) => /status\s*=\s*'active'/i.test(sql))
      .map((sql) => ({ file: path.relative(SRC, file), sql })));

  it('finds the readers it is meant to be guarding', () => {
    // A regex that matched nothing would make every assertion below vacuous —
    // the exact way a convention test rots into decoration.
    expect(readers.length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    'modules/pt-os/pt-os.routes.js',
    'modules/pt-os/workout-log.routes.js',
    // The two Today readers, which are the ones a trainer actually looks at.
    'modules/pt-os/pt-os.service.js',
    'routes/workouts.js',
  ])('still covers %s', (file) => {
    expect(readers.some((r) => r.file === file)).toBe(true);
  });

  // ── The rule: END with the shared chain ─────────────────────────────────
  //
  // Not "be" it. Two readers legitimately sort by something FIRST — the Today
  // roster and the session slot both prefer the assignment that actually
  // prescribes the day in question, which was measured against production when
  // it was written: 26 of 55 programmed client-days resolved to the wrong
  // assignment without it, and 8 of 14 on a Tuesday.
  //
  // What that fix did not give them was a TOTAL order underneath the
  // preference. Two same-day assignments that both prescribe Tuesday stayed
  // exactly as tied as before. So a leading key is allowed and the chain has
  // to be the last thing in the list, which is the only position that can
  // decide every remaining case.
  //
  // Reported as a LIST rather than one assertion per file, because the useful
  // failure message is "these readers drifted", not "the first one did".
  it('always ENDS with the shared rule, whatever it prefers first', () => {
    const drifted = readers
      .map(({ file, sql }) => ({
        file,
        order: sql.match(/ORDER\s+BY\s+([\s\S]*?)\s+LIMIT/i)?.[1]?.trim() ?? null,
      }))
      // A null order is the worse case, not a lesser one: no ORDER BY at all
      // leaves the choice entirely to the planner. It fails here too.
      .filter((o) => !o.order || !/\$\{(ACTIVE_ASSIGNMENT_ORDER|activeAssignmentOrder\([^)]*\))\}$/
        .test(o.order));
    expect(drifted).toEqual([]);
  });

  it('and every file that uses it imports it rather than retyping it', () => {
    const missing = [...new Set(readers.map((r) => r.file))]
      .filter((file) => !/require\(['"][^'"]*\/?assignments['"]\)/
        .test(fs.readFileSync(path.join(SRC, file), 'utf8')));
    expect(missing).toEqual([]);
  });
});

describe('the rule itself', () => {
  const { ACTIVE_ASSIGNMENT_ORDER, activeAssignmentOrder } = require('../modules/pt-os/assignments');

  it('is a total order over the three columns that can tie', () => {
    for (const col of ['wa.start_date DESC', 'wa.created_at DESC', 'wa.id DESC']) {
      expect(ACTIVE_ASSIGNMENT_ORDER).toContain(col);
    }
  });

  it('says the same thing under any alias', () => {
    expect(activeAssignmentOrder('a')).toBe(ACTIVE_ASSIGNMENT_ORDER.replace(/\bwa\./g, 'a.'));
  });

  // It is interpolated into SQL, so the alias is the one place a caller could
  // reach the statement. Stripped to word characters, and an alias that
  // strips to nothing is refused rather than silently producing `.start_date`.
  it('cannot carry anything but a bare alias', () => {
    expect(ACTIVE_ASSIGNMENT_ORDER).not.toMatch(/\$\d|\$\{|;|--/);
    expect(activeAssignmentOrder("a; DROP TABLE x --")).toBe(activeAssignmentOrder('aDROPTABLEx'));
    expect(() => activeAssignmentOrder('--')).toThrow();
  });
});
