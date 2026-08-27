'use strict';
// A borrowed client runs BEGIN before it runs anything else.
//
// db/pool.js sets app.org_id on a borrowed connection by noticing the caller's
// BEGIN and following it with set_config(). Anything queried on that client
// BEFORE the BEGIN therefore carries no org, and once DATABASE_URL points at
// app_tenant it is filtered by RLS with no GUC to match against. pool.js logs
// this as `tenant_scope_gap` at runtime — which only reports the paths someone
// happened to exercise. This finds them all, on the branch.
//
// ── The failure this prevents is worse than "returns nothing" ───────────
//
// Two handlers in routes/exercises.js read the exercise on the borrowed client
// before opening their transaction. `exercises` is a SHARED table — its policy
// admits organization_id IS NULL so the 890-row built-in library stays visible
// to every studio — so an unscoped read there does not come back empty. It
// comes back with the built-in library and WITHOUT the studio's own custom
// exercises.
//
// Verified against a real database with RLS enforced:
//
//   no app.org_id   → 'Built-in Squat'
//   with app.org_id → 'Built-in Squat', 'Studio A Special'
//
// So editing a built-in exercise would have worked and editing your own would
// have 404'd. That reads as data loss, not as a configuration problem, and it
// is the kind of thing a studio reports weeks later as "our exercises
// disappeared".

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/** Every source file, excluding tests. */
function sourceFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/__tests__/.test(p)) walk(p);
      } else if (e.name.endsWith('.js')) out.push(p);
    }
  })(SRC);
  return out;
}

/**
 * For each `pool.connect()`, the first statement issued on the client.
 *
 * Deliberately crude — it reads forward from the connect for the first
 * `.query(` — because the alternative is parsing the file, and the shape this
 * needs to catch (a SELECT sitting above the BEGIN) is visible without it.
 */
/**
 * Strip comments before scanning.
 *
 * Not cosmetic — it is what makes this check trustworthy. The scan reads a
 * fixed window forward from each connect, and the first draft counted comment
 * text toward it. Documenting the fix in exercises.js pushed the very call the
 * guard watches past the end of that window, and the check went green against
 * source it should have failed. A guard whose reliability depends on how much
 * prose sits above the code is not a guard. rls.convention.test.js next door
 * records the same lesson for SQL.
 */
function stripComments(src) {
  return src
    // Block comments keep their newlines, so the line numbers this reports
    // still point at the real file rather than a shifted copy of it.
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    // Line comments end at the newline, which the pattern never consumes.
    .replace(/\/\/[^\n]*/g, ' ');
}

function firstStatementAfterConnect(rawSrc) {
  const src = stripComments(rawSrc);
  const found = [];
  const re = /pool\.connect\(\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const window = src.slice(m.index, m.index + 900);
    // Only the BORROWED client's statements count. `pool.query()` in the same
    // window is not on this connection — it wraps its own scoping transaction,
    // and using it for a pre-BEGIN read is one of the two sanctioned fixes
    // below. An earlier draft of this matched any `.query(` and so reported a
    // handler that had just been fixed that way.
    const calls = [...window.matchAll(/(\w+)\s*\.\s*query\(\s*[`'"]\s*([A-Za-z]+)/g)];
    const borrowed = calls.find((c) => c[1] !== 'pool');
    found.push({
      line: src.slice(0, m.index).split('\n').length,
      first: borrowed ? borrowed[2].toUpperCase() : null,
    });
  }
  return found;
}

/**
 * Files where a borrowed client legitimately does not start with BEGIN.
 *
 * Each of these runs on the OWNER connection once the cutover happens — see
 * lib/tenant-context.js — so no app.org_id is expected or needed. Adding an
 * entry means asserting the code genuinely operates platform-wide.
 */
const REVIEWED_EXCEPTIONS = {
  'db/migrate.js':
    'Migrations run with no AsyncLocalStorage context at all, which routes '
    + 'them to the owner connection. They also have to run before the role and '
    + 'policies they create exist.',
  'db/pool.js':
    'The pool implementing this mechanism: its startup probe and the '
    + 'scopeClient wrapper itself, neither of which is a tenant query.',
  'modules/platform/super-admin/organizations.js':
    'Platform operator route. Runs platform-wide on the owner connection, '
    + 'which is the whole point of /api/super-admin.',
  'modules/platform/super-admin/registrations.js':
    'Platform operator route, same as organizations.js — it approves studio '
    + 'registrations, which by definition happens from outside any one studio.',
};

describe('borrowed clients open their transaction before they read', () => {
  const files = sourceFiles();

  it('finds the pool.connect() call sites it is guarding', () => {
    // Without this, a change in how connections are borrowed would make the
    // whole check green by finding nothing to look at.
    const total = files.reduce((n, f) => n + firstStatementAfterConnect(fs.readFileSync(f, 'utf8')).length, 0);
    expect(total).toBeGreaterThan(25);
  });

  it('no tenant path queries a borrowed client before its BEGIN', () => {
    const offenders = [];
    for (const f of files) {
      const rel = path.relative(SRC, f).split(path.sep).join('/');
      if (REVIEWED_EXCEPTIONS[rel]) continue;
      for (const site of firstStatementAfterConnect(fs.readFileSync(f, 'utf8'))) {
        if (site.first && !/^(BEGIN|START)$/.test(site.first)) {
          offenders.push(`${rel}:${site.line} — first statement is ${site.first}, not BEGIN`);
        }
      }
    }
    // A failure here means that statement will run without app.org_id once
    // DATABASE_URL points at app_tenant. Fix it one of two ways:
    //
    //   · move the read to pool.query(), which wraps its own scoping
    //     transaction — right when the read does not belong in the write
    //     transaction anyway; or
    //   · move BEGIN above it, and make sure every early return between the
    //     two rolls back rather than releasing a client mid-transaction.
    //
    // If the path genuinely runs platform-wide, add it to REVIEWED_EXCEPTIONS
    // above WITH the reason.
    expect(offenders).toEqual([]);
  });

  it('keeps the exception list honest', () => {
    const stale = [];
    for (const [rel, reason] of Object.entries(REVIEWED_EXCEPTIONS)) {
      const full = path.join(SRC, rel);
      if (!fs.existsSync(full)) { stale.push(`${rel} (file no longer exists)`); continue; }
      if (firstStatementAfterConnect(fs.readFileSync(full, 'utf8')).length === 0) {
        stale.push(`${rel} (no longer borrows a client — drop the exception)`);
      }
      expect(reason.length).toBeGreaterThan(40); // a real reason, not "ok"
    }
    expect(stale).toEqual([]);
  });
});
