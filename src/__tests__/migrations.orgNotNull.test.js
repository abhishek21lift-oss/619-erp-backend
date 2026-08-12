// Migration 155 must never be able to abort a deploy, or tighten a shared table.
//
// Audit finding H-5. organization_id was retrofitted NULLABLE onto the tables
// carrying most of the business data (migrations 079-097, 143) and never
// tightened, while every table designed multi-tenant from birth declares it
// NOT NULL. The consequence is silent data loss rather than a leak: a write
// path that fails to stamp the column produces a row belonging to nobody —
// invisible to every tenant's queries, present in the table, reported to the
// caller as success.
//
// Two things about the fix are easy to get wrong later, and both are worse than
// leaving the column nullable, so they are asserted here rather than trusted:
//
//   1. A bare SET NOT NULL against a table holding one orphan aborts the whole
//      migration run — and migrations now run inside the deploy (H-2), so that
//      is a production outage caused by a schema change whose purpose was to
//      surface a data problem. The migration must check first and skip loudly.
//
//   2. The shared/platform tables must stay out of the list. exercises holds
//      890 rows with a NULL organization_id because it is the library every
//      studio draws from; tightening it would require inventing an owner for
//      platform content, and the migration would either fail forever or force
//      someone to assign 890 shared rows to one tenant.

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'db', 'migrations', '155_organization_id_not_null.sql');
const sql = fs.readFileSync(FILE, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

/** The table names inside the `targets` array literal. */
function targets() {
  const m = body.match(/targets\s+TEXT\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

// Verified against the live database, not assumed. Each holds NULL
// organization_id rows that MEAN "belongs to the platform".
const SHARED_TABLES = [
  'exercises',                 // 890 rows, all NULL — the shared exercise library
  'diet_templates',            // shared templates
  'muscle_volume_landmarks',   // reference data
  'login_events',              // failed attempts with no identified user
  'users',                     // the platform super_admin has no organization
  'workout_plans',             // org-owned and shared template plans coexist
  'storage_objects',
  'user_webauthn_credentials',
];

/**
 * Tables whose NULLs are meaningful but must NOT be readable by every tenant.
 *
 * Kept apart from SHARED_TABLES above, because the two lists answer different
 * questions and these two tables answer them differently:
 *
 *   SHARED_TABLES  "may a NOT NULL constraint be added?"  and also
 *                  "should NULL rows be visible to every studio?" — for the
 *                  shared exercise library, both answers are the same, which
 *                  is why 157 reuses the one list for its RLS policy shape.
 *
 *   this list      "may a NOT NULL constraint be added?"  → NO, meaningful
 *                  "visible to every studio?"             → also NO
 *
 * Collapsing the two would hand every tenant a permissive RLS policy over
 * these tables, which is the opposite of what they need:
 *
 *   studio_registrations  A registration exists BEFORE the organisation it
 *                         asks for — created `pending` with no org, filled in
 *                         on approval (146). Nullable by design; and one
 *                         studio has no business reading another's
 *                         application.
 *   activity_log          158 backfills from the acting user's organisation
 *                         and leaves the rest NULL "rather than guessed at" —
 *                         platform super-admin actions, which have no owning
 *                         studio. Its strict policy correctly hides them from
 *                         tenants; the operator console reads them over the
 *                         owner connection.
 *
 * An earlier draft of migration 160 added both to SHARED_TABLES, which broke
 * the 157/158 cross-check — correctly, because it would have widened their
 * RLS policies as a side effect of documenting a NOT NULL exemption.
 */
const MEANINGFUL_NULLS_NOT_SHARED = [
  'studio_registrations',
  'activity_log',
];

describe('migration 155 — organization_id NOT NULL', () => {
  it('targets a real list of tables, so this cannot pass vacuously', () => {
    expect(targets().length).toBeGreaterThan(20);
    for (const core of ['pt_clients', 'pt_payments', 'attendance_logs', 'trainers']) {
      expect(targets()).toContain(core);
    }
  });

  it.each(SHARED_TABLES)('never tightens %s, whose NULLs are meaningful', (table) => {
    // Adding one of these to the list would either fail forever, or force
    // 890 shared exercises to be assigned to a single studio.
    expect(targets()).not.toContain(table);
  });

  it('counts NULLs before tightening each table', () => {
    expect(body).toMatch(/SELECT count\(\*\) FROM public\.%I WHERE organization_id IS NULL/);
  });

  it('only tightens when the count is zero', () => {
    expect(body).toMatch(/IF\s+null_count\s*=\s*0\s+THEN/);
    expect(body).toMatch(/ALTER COLUMN organization_id SET NOT NULL/);
  });

  it('WARNS rather than raising an exception when it finds orphans', () => {
    // RAISE EXCEPTION here would abort the migration run and, since H-2, the
    // deploy with it. The orphaned rows are already invisible to every tenant;
    // stopping the release does not make them visible.
    expect(body).toMatch(/RAISE WARNING/);
    expect(body).not.toMatch(/RAISE EXCEPTION/);
  });

  it('names the table and the row count in the warning, so it is actionable', () => {
    const warn = body.match(/RAISE WARNING[\s\S]*?;/)[0];
    expect(warn).toMatch(/%/);
    expect(warn).toMatch(/re-run this migration/i);
  });

  it('skips tables that do not exist in this environment', () => {
    // The schema grew across 154 migrations; not every environment has every
    // table. Same guard style as 101 and 148.
    expect(body).toMatch(/to_regclass\('public\.' \|\| t\) IS NULL/);
  });

  it('is idempotent — an already-NOT NULL column is left alone', () => {
    expect(body).toMatch(/is_nullable = 'YES'/);
  });
});

describe('migration 160 — the tables 155 could not reach', () => {
  const fs160 = require('fs');
  const path160 = require('path');
  const src160 = fs160.readFileSync(
    path160.join(__dirname, '..', 'db', 'migrations', '160_organization_id_not_null_round_two.sql'),
    'utf8'
  );
  const body160 = src160.replace(/--[^\n]*/g, ' ');

  /** Table names inside 160's targets array. */
  function targets160() {
    const arr = body160.match(/targets TEXT\[\] := ARRAY\[([\s\S]*?)\]/);
    return arr ? [...arr[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]) : [];
  }

  it('targets the three tables that gained organization_id after 155 ran', () => {
    expect(targets160().sort()).toEqual([
      'pt_mobility_performance_assessments',
      'pt_posture_assessments',
      'pt_trainers',
    ]);
  });

  it.each(SHARED_TABLES)('never tightens %s, whose NULLs are meaningful', (table) => {
    expect(targets160()).not.toContain(table);
  });

  it.each(MEANINGFUL_NULLS_NOT_SHARED)('never tightens %s either', (table) => {
    // These are not in SHARED_TABLES on purpose — see the comment on that
    // constant — so the exemption above does not cover them and they need
    // their own assertion. Tightening either would make it impossible to
    // register a studio, or to log a platform action.
    expect(targets160()).not.toContain(table);
  });

  it('counts NULLs before tightening, so an orphan skips instead of failing the deploy', () => {
    // migrate.js aborts the whole run on the first failure, so a bare
    // SET NOT NULL against a table holding one orphan would take the deploy
    // down — turning a data-quality issue into an outage.
    expect(body160).toMatch(/SELECT count\(\*\) FROM public\.%I WHERE organization_id IS NULL/);
    expect(body160).toMatch(/IF null_count = 0 THEN/);
    // WARNING like 155, and never EXCEPTION: aborting the run would take the
    // deploy down over rows that are already invisible to every studio.
    expect(body160).toMatch(/RAISE WARNING/);
    expect(body160).not.toMatch(/RAISE EXCEPTION/);
  });

  it('is idempotent and re-runnable', () => {
    expect(body160).toMatch(/is_nullable = 'YES'/);
    expect(body160).toMatch(/to_regclass/);
  });
});
