'use strict';
// Where the client actually is inside the programme they are already on.
//
// ── What this closes ───────────────────────────────────────────────────────
//
// A trainer pressing Generate for someone three weeks into a twelve-week block
// got a brand new twelve-week block. Not an adaptation, not a progression — a
// SECOND programme, written as though the first did not exist, and saved beside
// it as a second active assignment.
//
// The route was not ignorant of the assignment: it named it in the prompt as
// "currently assigned plan". It knew a plan existed and nothing about where
// inside it the client had got to, which is the difference between "they are
// training something" and "they are in week 4 of 12 at three sessions a week".
//
// The week comes from progression.js's own weekOf() — the same function that
// decides which week's prescription a logged session resolves against. Two
// answers to "what week is this client on" would be exactly the second truth
// the canonical context exists to prevent.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const { programState } = require('../modules/pt-os/client-context');
const { weekOf } = require('../modules/pt-os/progression');

const TODAY = '2026-09-14';
const plan = (over = {}) => ({
  plan_id: 'p1', plan_name: 'Base Phase', start_date: '2026-08-24',
  duration_weeks: 12, planned_days_count: 3, progress_pct: 25, ...over,
});

describe('no programme', () => {
  test('is active:false and nothing else invented', () => {
    expect(programState(null)).toEqual({ active: false });
  });
});

describe('a live programme', () => {
  test('reports the week, the block, and what is left', () => {
    const s = programState(plan(), [], TODAY);
    expect(s.active).toBe(true);
    expect(s.current_week).toBe(4);
    expect(s.duration_weeks).toBe(12);
    expect(s.weeks_remaining).toBe(8);
    expect(s.planned_days_per_week).toBe(3);
    expect(s.expired).toBe(false);
  });

  // The number the generator reads must be the number the session engine uses.
  test('the week is progression.js\'s own answer, not a second calculation', () => {
    for (const start of ['2026-08-24', '2026-09-14', '2026-01-01', '2026-09-13']) {
      expect(programState(plan({ start_date: start }), [], TODAY).current_week)
        .toBe(weekOf(start, TODAY));
    }
  });

  test('counts only completed sessions, and says the count is windowed', () => {
    const s = programState(plan(), [
      { status: 'completed' }, { status: 'completed' },
      { status: 'skipped' }, { status: 'scheduled' },
    ], TODAY);
    expect(s.sessions_completed_in_window).toBe(2);
  });
});

describe('a block that has run out', () => {
  // Its own state, not folded into "no programme": a block that finished last
  // month is a client who needs the NEXT one, which is a different
  // conversation from a client who never had one.
  test('is active and expired, both', () => {
    const s = programState(plan({ start_date: '2026-01-01', duration_weeks: 8 }), [], TODAY);
    expect(s.active).toBe(true);
    expect(s.expired).toBe(true);
    expect(s.weeks_remaining).toBe(0);
  });

  test('the last week of the block is not yet expired', () => {
    // Week 12 of a 12-week block.
    const s = programState(plan({ start_date: '2026-06-29', duration_weeks: 12 }), [], TODAY);
    expect(s.current_week).toBe(12);
    expect(s.expired).toBe(false);
  });
});

describe('a block with no stated length', () => {
  // "Unknown" and "none left" are different answers, and a programme with no
  // duration cannot be expired by arithmetic.
  test('has no weeks_remaining and is never expired', () => {
    const s = programState(plan({ duration_weeks: null, start_date: '2020-01-01' }), [], TODAY);
    expect(s.weeks_remaining).toBeNull();
    expect(s.expired).toBe(false);
    expect(s.current_week).toBeGreaterThan(100);
  });
});

// ── What the driver actually hands this function ───────────────────────────
//
// Every test above passes a 'YYYY-MM-DD' string, and every one of them passed
// against a version of this code that was broken in production.
//
// node-postgres parses a DATE column into a JS Date. The first version did
// `String(start_date).slice(0, 10)`, which on a Date gives "Mon Aug 24" — and
// weekOf cannot parse that, so it returned its no-answer fallback of week 1. A
// client three weeks into a block was reported as being in week 1 of it, and
// the adapt prompt would have told the model to continue from a week they
// finished a fortnight ago.
//
// A live endpoint answering `"started_on": "Mon Aug 24"` is what caught it.
// These are the tests that would have.
describe('the shapes a date column actually arrives in', () => {
  const AUG24 = '2026-08-24';

  test('a JS Date from the driver resolves the same week as the string', () => {
    const fromDriver = programState(plan({ start_date: new Date(`${AUG24}T00:00:00Z`) }), [], TODAY);
    const fromString = programState(plan({ start_date: AUG24 }), [], TODAY);
    expect(fromDriver.current_week).toBe(4);
    expect(fromDriver.current_week).toBe(fromString.current_week);
    expect(fromDriver.started_on).toBe(AUG24);
  });

  test('started_on is always a plain YYYY-MM-DD, never a rendered Date', () => {
    const s = programState(plan({ start_date: new Date(`${AUG24}T00:00:00Z`) }), [], TODAY);
    expect(s.started_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('an unusable date is no answer, not week 1', () => {
    // Week 1 is weekOf's fallback and is indistinguishable from a genuine
    // first week — which is exactly how the bug hid. Null says "unknown".
    const s = programState(plan({ start_date: null }), [], TODAY);
    expect(s.current_week).toBeNull();
    expect(s.started_on).toBeNull();
    expect(s.expired).toBe(false);
  });
});
