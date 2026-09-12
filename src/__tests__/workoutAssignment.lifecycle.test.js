// An assignment can stop being active — and cannot fork while doing it.
//
// `workout_assignments.status` was write-once. The INSERT set 'active', the
// only UPDATEs touched progress_pct, and the CHECK constraint promised four
// states that no code path could reach. Every read filtering
// `status = 'active'` was filtering on a constant:
//
//   active assignments                  53
//     …whose client is active           25
//     …whose client is pending          14
//     …whose client is expired          13
//     …whose client is soft-deleted      1
//
// 28 of 53 belonged to somebody who is not a live client, so a client kept
// being rostered by the programme they were last on. #129 stopped the Today
// panel believing it by checking the client at read time; migration 197 and
// syncClientAssignments fix the data underneath.
//
// ── The part that is easy to get wrong ────────────────────────────────────
//
// The table was keyed UNIQUE (workout_plan_id, client_id, status), so status
// was part of row IDENTITY. The moment an assignment could become 'paused',
// re-assigning that plan to that client would find no conflict on
// (plan, client, 'active') and insert a SECOND row — one client, one plan,
// two assignments. That is the multiple-active-assignments condition that
// made a programme invisible on the dashboard (#127).
//
// So the key had to narrow to (workout_plan_id, client_id) BEFORE status
// could move, and routes/workouts.js had to follow it in the same change or
// its ON CONFLICT would name a constraint that no longer exists and fail at
// runtime. Those two facts are what most of this file pins.
'use strict';

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** SQL/JS with its `--` and `//` comments stripped. This change explains
 *  itself at length and the prose names the very clauses asserted below. */
const code = (s) => s.replace(/--[^\n]*/g, ' ').replace(/^\s*\/\/.*$/gm, '');

const MIGRATION = read('db', 'migrations', '197_workout_assignment_lifecycle.sql');
const SERVICE   = read('modules', 'pt-os', 'pt-os.service.js');
const PTOS      = read('modules', 'pt-os', 'pt-os.routes.js');
const WORKOUTS  = read('routes', 'workouts.js');

describe('migration 197 — the key swap', () => {
  const sql = code(MIGRATION);

  it('refuses rather than silently dropping a row', () => {
    // The new key is narrower. If any (plan, client) pair already held two
    // rows, creating it would destroy one — so the migration checks first and
    // raises instead of assuming its own precondition.
    expect(sql).toMatch(/RAISE EXCEPTION '197 refused/);
    expect(sql).toMatch(/GROUP BY workout_plan_id, client_id\s*HAVING count\(\*\) > 1/);
  });

  it('drops the status-keyed constraint and adds the pair-keyed one', () => {
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS workout_assignments_workout_plan_id_client_id_status_key');
    expect(sql).toMatch(/ADD CONSTRAINT workout_assignments_plan_client_key\s+UNIQUE \(workout_plan_id, client_id\)/);
  });

  it('retires before it swaps', () => {
    // Retiring is a status change, and under the OLD key a status change is
    // an identity change. Doing it first keeps each step valid on its own.
    const firstRetire = sql.indexOf("SET status = 'cancelled'");
    const dropsKey = sql.indexOf('DROP CONSTRAINT IF EXISTS workout_assignments_workout_plan_id_client_id_status_key');
    expect(firstRetire).toBeGreaterThan(-1);
    expect(dropsKey).toBeGreaterThan(-1);
    expect(firstRetire).toBeLessThan(dropsKey);
  });

  it('cancels a deleted client\'s programmes and pauses a lapsed one\'s', () => {
    // Deleted is terminal; expired or pending is not, and a studio that
    // reactivates the client gets the programme back untouched.
    expect(sql).toMatch(/SET status = 'cancelled'[\s\S]*?c\.deleted_at IS NOT NULL/);
    expect(sql).toMatch(/SET status = 'paused'[\s\S]*?c\.status IS DISTINCT FROM 'active'/);
  });

  it('deletes nothing', () => {
    // Every row keeps its plan, dates, progress and notes; only status moves.
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+workout_assignments\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('checks its own end state instead of assuming it', () => {
    expect(sql).toMatch(/RAISE EXCEPTION '197 failed its own check/);
  });

  it('opens no transaction of its own', () => {
    // migrate.js wraps each migration with the _migrations insert that records
    // it; a migration that opens its own closes the runner's early.
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/mi);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/mi);
  });
});

describe('the upsert follows the key', () => {
  const sql = code(WORKOUTS);

  it('conflicts on (plan, client), not on status', () => {
    // If this still named the dropped constraint it would fail at runtime the
    // moment 197 ran. The two ship together for that reason.
    expect(sql).toContain('ON CONFLICT (workout_plan_id, client_id)');
    expect(sql).not.toContain('ON CONFLICT (workout_plan_id, client_id, status)');
  });

  it('revives the existing row rather than forking it', () => {
    // A client who lapsed and came back gets their programme, its progress
    // and its notes — not a blank second copy alongside the paused one.
    const at = sql.indexOf('ON CONFLICT (workout_plan_id, client_id)');
    const clause = sql.slice(at, at + 400);
    expect(clause).toMatch(/DO UPDATE SET status = 'active'/);
  });
});

describe('syncClientAssignments', () => {
  const fn = code(SERVICE.slice(
    SERVICE.indexOf('async function syncClientAssignments'),
    SERVICE.indexOf('getTodayRoster — THE canonical'),
  ));

  it('derives the target state from the client row, not from the caller', () => {
    // Idempotent, and it cannot disagree with 197's backfill — one rule,
    // written once. A caller passing its own intent could drift from the
    // migration the first time somebody edits one and not the other.
    expect(fn).toMatch(/FROM pt_clients c/);
    expect(fn).toMatch(/WHEN c\.deleted_at IS NOT NULL\s+THEN 'cancelled'/);
    expect(fn).toMatch(/WHEN c\.status IS DISTINCT FROM 'active'\s+THEN 'paused'/);
    expect(fn).toMatch(/ELSE 'active'/);
  });

  it('moves only between active and paused, plus cancel on delete', () => {
    // 'completed' and 'cancelled' are terminal: a programme somebody finished,
    // or a deleted client's plan, is not resurrected by a status edit. The one
    // way out is an explicit re-assignment, which the upsert handles.
    expect(fn).toMatch(/c\.deleted_at IS NULL AND c\.status IS DISTINCT FROM 'active' AND a\.status = 'active'/);
    expect(fn).toMatch(/c\.deleted_at IS NULL AND c\.status = 'active' AND a\.status = 'paused'/);
    expect(fn).not.toMatch(/a\.status = 'completed'/);
  });

  it('writes nothing when nothing needs to move', () => {
    // Called on every client PATCH, so the common case must cost one
    // statement and no writes rather than touching every row each time.
    expect(fn).toMatch(/AND \(\s*\(c\.deleted_at IS NOT NULL/);
  });

  it('is scoped to the one client', () => {
    expect(fn).toMatch(/a\.client_id = \$1/);
  });
});

describe('the client write paths keep assignments in step', () => {
  const src = code(PTOS);

  it('PATCH /clients/:id syncs after the update', () => {
    // The status change is what retires or restores the programmes, and it
    // must run on the row that was actually written — including the case
    // where the enrolment promotion set status without the caller asking.
    expect(src).toMatch(/await svc\.syncClientAssignments\(rows\[0\]\.id\)/);
  });

  it('soft-delete syncs too', () => {
    const del = src.slice(src.indexOf("router.delete('/clients/:id'"));
    expect(del.slice(0, 900)).toMatch(/await svc\.syncClientAssignments\(rows\[0\]\.id\)/);
  });

  it('both call sites exist, not just one', () => {
    const calls = src.match(/svc\.syncClientAssignments\(/g) || [];
    expect(calls).toHaveLength(2);
  });
});
