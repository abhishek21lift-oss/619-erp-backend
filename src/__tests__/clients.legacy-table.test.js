// No runtime code anywhere may touch the legacy `clients` table.
//
// ── Why this table is different from every other one ────────────────────────
//
// `clients` has no organization_id column. Not "is missing a filter" — there is
// nothing to filter ON. Any handler reading or writing it is unscopable by
// construction, and this mount sits behind plain `auth`, so such a handler is
// reachable by any logged-in user of any studio.
//
// That is exactly what used to be here. routes/client-actions.js carried
// thirteen endpoints — freeze, unfreeze, transfer, upgrade, downgrade, combo,
// trial, assign-pt, extension, renew-pt, add-subscription, renew-subscription,
// photo — every one of them `SELECT * FROM clients WHERE id=$1` followed by an
// `UPDATE clients`. routes/clients.js carried two more (renew, pt-renew).
//
// None of it ever did damage, and the reason is worth stating plainly because
// it is not a good one: the table has held 0 rows since the PT-OS enrolment
// flow shipped, so every handler 404'd before reaching its UPDATE. The safety
// came from the data, not from the code. One inserted row would have turned
// fifteen endpoints into a cross-tenant write surface.
//
// ── Why a source scan and not a request test ────────────────────────────────
//
// The bug is not "returns the wrong answer" — it is "this query exists at all".
// A request test would need a database with rows in a table that no longer
// exists, and it would pass for the wrong reason (404) right up until the day
// it stopped passing for the wrong reason.
//
// ── Why this now scans everything instead of one mount ──────────────────────
//
// It used to read server.js for whatever was mounted at /api/clients and scan
// only those files. That mount is gone: /api/clients was a second HTTP surface
// over pt_clients and its handlers moved to /api/pt-os/clients. A guard scoped
// to a mount that no longer exists would scan an empty list and pass
// vacuously — the worst possible outcome for a security test.
//
// So the scan widened to every runtime .js under src/, which is also what the
// rule always meant. The table is gone from the database (migration 170), so
// ANY statement naming it is a query against nothing: a guaranteed 500 if it is
// ever reached, not merely an unscopable read. There is no file left where it
// would be acceptable.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const SERVER = path.join(SRC, 'server.js');

/**
 * `clients` as a table name, never `pt_clients`.
 *
 * The negative lookbehind on `_` is what keeps this from matching pt_clients,
 * which every legitimate handler on this mount uses. Aliases (`clients c`) and
 * schema-qualified forms both still match on the table name itself.
 */
const LEGACY_SQL = /\b(?:FROM|UPDATE|INTO|JOIN)\s+(?<!_)clients\b/i;

/**
 * Every runtime .js file under src/, excluding tests and migrations.
 *
 * Tests are excluded because this very file quotes the forbidden SQL in order
 * to prove its own regex works. Migrations are excluded because the history of
 * the table — creating it, and 170 dropping it — is legitimately written in
 * SQL that names it.
 */
function runtimeFiles(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations' || e.name === 'node_modules') continue;
      runtimeFiles(full, out);
    } else if (e.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

describe('the legacy clients table is gone and stays gone', () => {
  test('the scan can see a meaningful number of files', () => {
    // Without this, a broken walk would make every assertion below pass
    // against nothing at all — which is exactly how the previous version of
    // this guard would have failed silently once its mount was removed.
    expect(runtimeFiles().length).toBeGreaterThan(50);
  });

  test('/api/clients is no longer mounted at all', () => {
    // The consolidation this guard now protects: one HTTP surface over
    // pt_clients, at /api/pt-os/clients. A second mount reappearing is how the
    // duplication started the first time.
    const server = fs.readFileSync(SERVER, 'utf8');
    const mounts = server
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .filter((l) => /app\.use\(\s*'\/api\/clients'/.test(l));
    expect(mounts).toEqual([]);
  });

  test('routes/clients.js is gone, not merely unmounted', () => {
    expect(fs.existsSync(path.join(SRC, 'routes', 'clients.js'))).toBe(false);
  });

  test('no runtime file reads or writes the legacy `clients` table', () => {
    const offenders = [];
    for (const file of runtimeFiles()) {
      const rel = path.relative(SRC, file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Comments are the record of WHY these were removed; they quote the
        // very SQL this test forbids, and must not trip it.
        // Skip lines that are purely comments (start with // or /*)
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          return;
        }
        // Also strip inline // comments
        const code = line.replace(/\/\/.*$/, '');
        if (LEGACY_SQL.test(code)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('routes/client-actions.js is gone, not merely unmounted', () => {
    // Unmounting alone would leave 734 lines that the next person could
    // reasonably re-mount, all of it still un-scopable.
    expect(fs.existsSync(path.join(SRC, 'routes', 'client-actions.js'))).toBe(false);
  });

  test('the pattern distinguishes `clients` from `pt_clients`', () => {
    // The whole guard rests on this one regex. If it matched pt_clients the
    // suite would be unpassable; if it missed `clients` it would be useless.
    expect(LEGACY_SQL.test('SELECT * FROM clients WHERE id=$1')).toBe(true);
    expect(LEGACY_SQL.test('UPDATE clients SET status=$1')).toBe(true);
    expect(LEGACY_SQL.test('INSERT INTO clients (id) VALUES ($1)')).toBe(true);
    expect(LEGACY_SQL.test('JOIN clients c ON c.id = p.client_id')).toBe(true);
    expect(LEGACY_SQL.test('SELECT * FROM pt_clients WHERE id=$1')).toBe(false);
    expect(LEGACY_SQL.test('UPDATE pt_clients SET status=$1')).toBe(false);
    expect(LEGACY_SQL.test('JOIN pt_clients pc ON pc.id = s.client_id')).toBe(false);
  });
});
