// Money is only ever written to the ledger that carries a tenant.
//
// There are two payment tables. `pt_payments` has an organization_id column.
// The legacy `payments` table does not, and never has — LEDGER_SQL unions it
// in as `NULL::uuid AS organization_id` so it can be read at all. Every
// org-scoped aggregate in the product filters on that column, so a row written
// to the legacy table is recorded and then invisible to the studio that earned
// it. Nothing throws. No total goes red. The money simply is not there.
//
// That is exactly what POST /api/invoices/:id/mark-paid did until P0.5.
//
// The route-level fix is pinned in invoices.routes.test.js. This is the wider
// guard: it reads every source file and asserts that no INSERT reaches the
// legacy table. A route test can only protect the route it was written for,
// and the failure mode here is a new handler copying an old one.
//
// ── Why the check is static ─────────────────────────────────────────────
//
// Same reasoning as rls.convention.test.js: the runtime version of this test
// needs a database CI does not have, and would only catch the mistake after
// the row was written. Reading the source catches it on the branch.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/** Every .js file under src/, excluding this suite's own neighbours. */
function sources(dir = SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sources(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push({ file: path.relative(SRC, full), src: fs.readFileSync(full, 'utf8') });
    }
  }
  return out;
}

/** Strip comments, so prose about the legacy table is not mistaken for a write.
 *  This file's own explanation would otherwise be the first failure. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// `\b` after `payments` is what separates the legacy table from `pt_payments`,
// `membership_payments` and `subscription_payments`. "INTO payments" cannot
// match "INTO pt_payments" — the preceding characters differ — but the word
// boundary is kept explicit so the intent survives an edit.
const LEGACY_INSERT = /INSERT\s+INTO\s+payments\b/i;

// One known site, and it is dead code rather than an exception granted on
// judgement. src/workers/renewal.worker.js names eight columns; six of them —
// member_id, gateway, gateway_txn_id, gateway_status and the membership fields
// its surrounding statements need — do not exist on any table in the migrated
// schema. Verified by running all four of runAutoRenew's statements against a
// database with the full migration chain applied:
//
//   runReminders SELECT      → column mm.plan_id does not exist
//   runAutoRenew SELECT      → column mm.plan_id does not exist
//   membership INSERT        → column "plan_id" of relation "member_memberships"
//   payment INSERT           → column "member_id" of relation "payments"
//
// runReminders runs first inside runDailyRenewalTasks and throws, so the
// auto-renew pass is never entered; and if it were, it would throw on its own
// first statement, long before the INSERT. The members domain behind it holds
// zero rows, has no organization_id column, and its API surface was already
// removed (see MEMBERS-TENANT-GAP.md and 021_remove_members_feature.sql).
//
// It is listed rather than deleted because removing an auto-renew feature is a
// product decision, not a correctness fix. What matters here is that it stays
// the ONLY one: if it ever becomes executable, or a second appears, this fails.
const KNOWN_DEAD = ['workers/renewal.worker.js'];

describe('no code writes to the legacy payments table', () => {
  const offenders = sources()
    .filter(({ src }) => LEGACY_INSERT.test(stripComments(src)))
    .map(({ file }) => file.split(path.sep).join('/'));

  test('every INSERT goes to pt_payments, which carries organization_id', () => {
    expect(offenders.filter((f) => !KNOWN_DEAD.includes(f))).toEqual([]);
  });

  test('the known-dead site has not been quietly removed from the guard', () => {
    // A stale allowance is how a guard rots into decoration. If the worker is
    // deleted or rewritten, this fails and the entry must go with it.
    expect(offenders).toEqual(expect.arrayContaining(KNOWN_DEAD));
  });

  test('mark-paid writes to the canonical ledger with an explicit organization', () => {
    const src = fs.readFileSync(path.join(SRC, 'routes', 'invoices.js'), 'utf8');
    const stripped = stripComments(src);
    expect(stripped).toMatch(/INSERT INTO pt_payments/i);
    expect(stripped).not.toMatch(LEGACY_INSERT);
    // The org is taken from the invoice row — already proven to belong to the
    // caller by the tenant-guarded UPDATE above it — and never from the body.
    expect(stripped).toMatch(/inv\[0\]\.organization_id/);
  });
});
