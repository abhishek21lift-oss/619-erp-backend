'use strict';
// An HTTP adapter holds no SQL — and the debt only ever shrinks.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
// The target architecture is four layers in one direction:
//
//   route (adapter) → application service → domain service → repository → DB
//
// The adapter parses, validates, guards and serialises. It does not reach the
// database. Today 50 of 57 adapter files do exactly that, 782 SQL literals in
// total, and `routes/ai.js` alone issues 42 — so a test that simply forbids it
// would fail on the first run and be skipped by the second week.
//
// ── Why a ratchet instead ───────────────────────────────────────────────────
//
// BUDGETS below records what each file holds TODAY. A file may hold fewer than
// its budget; it may never hold more, and a file absent from the table may
// hold none at all. That makes the migration measurable and safe in both
// directions at once: phase 4 extracts one domain at a time and lowers its
// entry, while nothing can quietly add a 783rd literal in the meantime.
//
// The numbers are a debt register, not a target. Every one of them is meant to
// reach zero and be deleted from this file; when BUDGETS is empty the rule
// becomes absolute and this comment can go with it.
//
// ── What counts as SQL ──────────────────────────────────────────────────────
//
// The same detection tenantColumns.convention.test.js uses, deliberately:
// two tests disagreeing about what a SQL literal is would produce two
// different debt figures for one codebase. Scanning raw file text instead
// matches English prose — this codebase's comments are long and name tables
// constantly — so only string and template literals that actually read like
// SQL are counted.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/**
 * The files that are HTTP adapters.
 *
 * Everything under src/routes (the legacy generation, all of which are
 * adapters) plus every *.routes.js inside a module. A module's service,
 * repository and rules files are NOT adapters and are where SQL belongs.
 */
function adapterFiles() {
  const out = [];

  const routes = path.join(SRC, 'routes');
  if (fs.existsSync(routes)) {
    for (const f of fs.readdirSync(routes).sort()) {
      if (f.endsWith('.js')) out.push(path.join(routes, f));
    }
  }

  const modules = path.join(SRC, 'modules');
  if (fs.existsSync(modules)) {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.routes.js')) out.push(p);
      }
    }(modules));
  }

  return out;
}

/** SQL-looking string and template literals in a source file. */
function sqlLiteralsIn(src) {
  const out = [];
  let m;

  const tpl = /`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  while ((m = tpl.exec(src)) !== null) {
    if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i.test(m[1])) out.push(m[1]);
  }

  const str = /(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
  while ((m = str.exec(src)) !== null) {
    if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(m[2])
      && /\b(FROM|INTO|UPDATE)\s+[a-z_]/i.test(m[2])) out.push(m[2]);
  }

  return out;
}

function rel(file) {
  return path.relative(SRC, file).split(path.sep).join('/');
}

/**
 * The debt register, measured on the commit that introduced this test.
 *
 * Ordered by size so the extraction order in roadmap phase 4 is readable off
 * the page: pt-os (93 + 49 + 28 + 18 across four adapters) is one domain
 * pretending to be four, and training is spread over three files that each
 * describe the same thing.
 */
const BUDGETS = {
  'modules/pt-os/pt-os.routes.js': 93,
  'modules/pt-os/workout-log.routes.js': 49,
  'routes/exercises.js': 43,
  'routes/workouts.js': 43,
  'routes/ai.js': 42,
  'modules/progress/progress.routes.js': 33,
  'routes/profile.js': 29,
  'modules/pt-os/parq.routes.js': 28,
  'modules/training/training.routes.js': 27,
  'routes/auth-webauthn.js': 26,
  'routes/auth.js': 24,
  'routes/upi-payments.js': 21,
  'modules/pt-os/informed-consent.routes.js': 18,
  'routes/attendance.js': 18,
  'routes/settings.js': 18,
  'routes/subscription.js': 18,
  'routes/clients.js': 17,
  'routes/invoices.js': 17,
  'routes/qr-checkin.js': 15,
  'routes/trainers.js': 15,
  'modules/automation/automation.routes.js': 14,
  'routes/admin-reset.js': 14,
  'routes/payments.js': 13,
  'routes/diet.js': 12,
  'routes/client-login.js': 11,
  'routes/communication.js': 10,
  'routes/expenses.js': 10,
  'routes/reports.js': 9,
  'routes/leave.js': 8,
  'routes/offers.js': 8,
  'routes/campaigns.js': 7,
  'routes/feedback.js': 7,
  'modules/client-portal/client-portal.routes.js': 6,
  'routes/aiKnowledge.js': 6,
  'routes/whatsapp.js': 6,
  'routes/client-activation.js': 5,
  'routes/invitations.js': 5,
  'routes/plans.js': 5,
  'routes/support.js': 5,
  'modules/ai-actions/ai-actions.routes.js': 4,
  'modules/operations/operations.routes.js': 4,
  'modules/command-center/command-center.routes.js': 3,
  'routes/auth-google.js': 3,
  'routes/integrations.js': 3,
  'routes/razorpay-webhook.js': 3,
  'routes/uploads.js': 2,
  'routes/whatsapp-webhook.js': 2,
  'routes/classes.js': 1,
  'routes/features.js': 1,
  'routes/public.js': 1,
};

/** Measured once — several tests read it. */
const measured = (() => {
  const counts = new Map();
  for (const file of adapterFiles()) {
    counts.set(rel(file), sqlLiteralsIn(fs.readFileSync(file, 'utf8')).length);
  }
  return counts;
})();

describe('the layering rule: no SQL in an HTTP adapter', () => {
  it('no adapter outside the debt register holds SQL', () => {
    // The half of the ratchet that protects clean files. A newly written
    // route, or one phase 4 has already finished, must reach the database
    // through a repository like every other.
    const offenders = [...measured.entries()]
      .filter(([f, n]) => n > 0 && !(f in BUDGETS))
      .map(([f, n]) => `${f} holds ${n} SQL literal(s) and is not in BUDGETS`)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('no adapter holds more SQL than its recorded budget', () => {
    // The half that stops the debt growing inside files that already carry
    // some. Lowering a budget is the deliverable of a phase-4 extraction;
    // raising one is never correct — if a file genuinely needs another query,
    // that query belongs in the repository the extraction is heading toward.
    const grew = [];
    for (const [file, budget] of Object.entries(BUDGETS)) {
      const now = measured.get(file);
      if (now === undefined) continue; // handled by the stale-entry test below
      if (now > budget) grew.push(`${file}: ${now} > budget ${budget}`);
    }
    expect(grew.sort()).toEqual([]);
  });

  it('the register has no stale entries', () => {
    // A budget for a file that no longer exists, or that is already clean,
    // hides progress and eventually makes the register untrustworthy. Deleting
    // the line is part of finishing the extraction.
    const stale = Object.keys(BUDGETS)
      .filter((f) => (measured.get(f) ?? 0) === 0)
      .map((f) => `${f} is clean (or gone) — delete its BUDGETS entry`)
      .sort();
    expect(stale).toEqual([]);
  });

  it('the scanner finds real files and real SQL', () => {
    // Guard against the whole suite passing for free. If adapterFiles() ever
    // stops matching — a directory rename, a change of suffix convention —
    // every assertion above would pass on an empty set and report an
    // architecture that had silently stopped being measured.
    expect(measured.size).toBeGreaterThanOrEqual(50);
    expect(measured.get('routes/ai.js')).toBeGreaterThan(0);
  });
});

describe('the migration has a number attached to it', () => {
  it('reports the outstanding layering debt', () => {
    // Not a threshold — a burn-down. Phase 4 lowers this figure one domain at
    // a time, and the ceiling below is lowered with it. The test exists so the
    // number is visible in CI rather than requiring somebody to go and count.
    const total = [...measured.values()].reduce((a, b) => a + b, 0);
    const ceiling = Object.values(BUDGETS).reduce((a, b) => a + b, 0);

    expect(total).toBeLessThanOrEqual(ceiling);
    // Recorded so a reader of a failing run knows what "good" looked like.
    expect(ceiling).toBe(782);
  });
});
