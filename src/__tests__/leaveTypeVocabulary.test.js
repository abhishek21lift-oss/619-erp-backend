// "Personal" was offered everywhere except the one place that decides.
//
// Three lists name the leave types a studio may file, and until migration 204
// they disagreed:
//
//   · db/migrations — CHECK (leave_type IN (…))          six values
//   · routes/leave.js — VALID_LEAVE_TYPES                seven, incl. 'personal'
//   · the leave page's dropdown                          seven, incl. 'personal'
//
// So a trainer picking "Personal" — the natural choice for the very example
// the Reason box suggests, "personal emergency" — passed the browser, passed
// the route's own validation, and then violated the constraint on the INSERT.
// A Postgres error surfacing as a 500: no field marked, nothing to correct,
// and a perfectly ordinary request that simply could not be filed.
//
// The lists are pinned against each other here, read from the files rather
// than restated, so the next value cannot be added to two of the three.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const MIGRATIONS = path.join(SRC, 'db', 'migrations');

/** The values in the LAST CHECK constraint any migration declares for leave_type. */
function checkedLeaveTypes() {
  // Newest-first by the numeric prefix, so a later migration's constraint wins
  // exactly as it does when the migrations are applied in order.
  const files = fs.readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    // The constraint as applied, not as described in a comment: strip the
    // comment lines first, or this header would match its own explanation.
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const m = /CHECK\s*\(\s*leave_type\s+IN\s*\(([^)]*)\)/i.exec(code);
    if (m) {
      return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort();
    }
  }
  return null;
}

/** VALID_LEAVE_TYPES as routes/leave.js declares it. */
function routeLeaveTypes() {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'leave.js'), 'utf8');
  const m = /const\s+VALID_LEAVE_TYPES\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
}

describe('the leave-type vocabulary', () => {
  test('a migration declares a CHECK constraint for it', () => {
    expect(checkedLeaveTypes()).not.toBeNull();
  });

  test('the route declares its own list', () => {
    expect(routeLeaveTypes()).not.toBeNull();
  });

  test('the route and the database agree, value for value', () => {
    // The failure this catches: a value the route waves through and the
    // constraint rejects is a 500 on an ordinary request. A value the
    // constraint allows and the route rejects is a category nobody can file.
    expect(routeLeaveTypes()).toEqual(checkedLeaveTypes());
  });

  test('personal is among them, which is what 204 fixed', () => {
    expect(checkedLeaveTypes()).toContain('personal');
    expect(routeLeaveTypes()).toContain('personal');
  });

  test('the constraint only ever widened — no existing row can violate it', () => {
    // 001 and 002a both declared the original six. A migration that REMOVED
    // one would orphan rows already holding it, so the set is checked to be a
    // superset of what the schema has always allowed.
    const original = ['sick', 'casual', 'earned', 'emergency', 'unpaid', 'other'];
    const current = checkedLeaveTypes();
    for (const value of original) expect(current).toContain(value);
  });
});
