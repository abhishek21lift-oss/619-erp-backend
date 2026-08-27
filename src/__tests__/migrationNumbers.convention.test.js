'use strict';
// Two migrations must not share a number.
//
// ── Why this matters more than it looks ────────────────────────────────────
//
// migrate.js sorts by full filename and records applied files by name in
// `_migrations`, so duplicate numbers do not break anything on their own —
// every file still runs exactly once. That is why five collisions accumulated
// without anyone noticing.
//
// What breaks is the assumption everybody makes about a numbered sequence:
// that the number tells you the order. With two files sharing a prefix the
// order is decided by the rest of the filename, alphabetically, which nobody
// chose. And a database that already applied them in a DIFFERENT order keeps
// that order forever, because `_migrations` is keyed by name.
//
// Comparing production's `applied_at` against the order a fresh install would
// produce, at the time this test was written:
//
//   prefix  production (applied_at)              fresh install (alphabetical)
//   131     rename_platform… → close_rls_gaps    close_rls_gaps → rename_platform…   INVERTED
//   140     exercise_library → subscription…     exercise_library → subscription…    same
//   174     tenant_columns…  → cardio_prescr…    cardio_prescr… → tenant_columns…    INVERTED
//   175     users_tenant…    → cardio_perf…      cardio_perf…   → users_tenant…      INVERTED
//   176     classes_bookings → cardio_progr…     cardio_progr…  → classes_bookings   INVERTED
//
// Four of the five are inverted. **A fresh install does not reproduce
// production's schema history.** 174 is the sharpest example: in production
// `174_tenant_columns_for_untenanted_tables.sql` added organization_id to
// twelve tables and enabled RLS a full day BEFORE
// `174_cardio_prescription_upgrade.sql` rewrote rows in `exercises`. On a new
// box the cardio migration goes first. Nothing has depended on that ordering
// yet. The next migration to assume "everything numbered ≤ 174 has run" would
// be the one to find out.
//
// ── Why the existing files are not renamed ─────────────────────────────────
//
// `_migrations` records applied migrations BY FILENAME. Renaming an applied
// file makes the runner see a migration it has never applied and run it again
// — against a database that already has its changes. For DDL guarded by
// IF NOT EXISTS that is merely wasteful; for an UPDATE like the cardio one it
// is a second write. All ten files below are applied in production, so the
// collisions are permanent and the only useful move is to stop the sixth.

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

/**
 * Collisions that already exist and cannot be undone.
 *
 * Adding an entry here is not a way to land a duplicate number — it is a
 * record that one shipped before this test existed. A new duplicate must be
 * renumbered instead, which costs nothing before it is applied anywhere.
 */
const GRANDFATHERED = {
  131: 'Applied 28-29 July, before this test existed. Production ran rename_platform_super_admin first, a fresh install runs close_rls_gaps first — inverted, and unfixable now that both are recorded in _migrations by name.',
  140: 'Applied 1 August. The only collision whose production order matches what a fresh install produces (exercise_library then subscription_payment_dedup), so it is inert rather than merely undetected.',
  174: 'Two parallel work streams merged the same day: the audit\'s tenant-column migration and the cardio prescription upgrade. Production applied tenant_columns a day earlier; a fresh install runs cardio first. Inverted.',
  175: 'Same pair of work streams as 174. Production applied users_tenant_or_platform at 04:19 and cardio_performance_steps_floors at 12:10; alphabetically cardio wins. Inverted.',
  176: 'Same pair again. Production applied classes_bookings_tenant_columns at 04:19 and cardio_progression_notes at 12:28; alphabetically cardio wins. Inverted.',
};

/** Migration filenames, and the numeric prefix of each. */
function migrations() {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Map of version prefix -> [filenames], for prefixes used more than once.
 *
 * The key is the FULL prefix including any letter, so `002` and `002a` are
 * two different versions rather than a collision — which is the point of the
 * letter, and the reason it is the right fix for a clash.
 */
function duplicates() {
  const byPrefix = new Map();
  for (const f of migrations()) {
    const m = f.match(/^(\d+[a-z]?)_/);
    if (!m) continue;
    const n = m[1];
    if (!byPrefix.has(n)) byPrefix.set(n, []);
    byPrefix.get(n).push(f);
  }
  const dupes = new Map();
  for (const [n, files] of byPrefix) if (files.length > 1) dupes.set(n, files);
  return dupes;
}

describe('migration numbers are unique', () => {
  it('reads a real set of migrations', () => {
    // A path change that matched nothing would make every assertion below
    // vacuously true — the failure mode of every source-reading guard here.
    expect(migrations().length).toBeGreaterThan(150);
  });

  it('every migration filename starts with a version prefix', () => {
    // The prefix is what the whole scheme rests on; a file without one is
    // invisible to this check and sorts unpredictably against the rest.
    //
    // A trailing letter counts. Nine migrations already use one — 002a, 011b,
    // 019b, 030b and friends — to slot a follow-up immediately after a
    // released number without disturbing anything after it. That convention
    // is also the ANSWER to this whole problem: a migration that needs to sit
    // beside 174 should be 174a, which sorts deterministically and collides
    // with nothing.
    const unnumbered = migrations().filter((f) => !/^\d+[a-z]?_/.test(f));
    expect(unnumbered).toEqual([]);
  });

  it('no NEW migration shares a number with an existing one', () => {
    const offenders = [];
    for (const [n, files] of duplicates()) {
      if (GRANDFATHERED[n]) continue;
      offenders.push(`${n}: ${files.join(' + ')}`);
    }
    // Renumber the new file. Before it has been applied anywhere that is a
    // rename and nothing else; afterwards it is permanent.
    expect(offenders.sort()).toEqual([]);
  });

  it('the grandfathered list still describes reality', () => {
    // An entry that outlives its collision is a note about a problem nobody
    // has, and it silently widens the rule for the next one.
    const dupes = duplicates();
    const stale = Object.keys(GRANDFATHERED).filter((n) => !dupes.has(n));
    expect(stale).toEqual([]);
  });

  it('every grandfathered entry gives a reason, not a shrug', () => {
    for (const [n, reason] of Object.entries(GRANDFATHERED)) {
      expect(String(n)).toMatch(/^\d+[a-z]?$/);
      expect(reason.length).toBeGreaterThan(80);
    }
  });

  it('the runner still orders migrations by filename', () => {
    // The entire argument above rests on this. If migrate.js starts ordering
    // by something else — an explicit list, applied_at, a manifest — then
    // duplicate prefixes stop being an ordering hazard and this test is
    // measuring the wrong thing.
    const runner = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
    expect(runner).toMatch(/\.sort\(\)/);
    expect(runner).toMatch(/readdirSync/);
  });
});
