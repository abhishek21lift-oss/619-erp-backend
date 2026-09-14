'use strict';

// Which programme a client is on, when more than one row says "active".
//
// The property under test is TOTALITY: for any two assignments, the comparator
// must put one strictly before the other. A partial order leaves ties, and a
// tie is exactly the state that let the generator and the session log show a
// trainer two different weeks for the same client.

const {
  ACTIVE_ASSIGNMENT_ORDER, selectActiveAssignment, compareAssignments,
  ambiguityOf, cmpDesc, dayOf, timeOf,
} = require('../modules/pt-os/assignments');

const A = (over = {}) => ({
  id: 'a1', plan_id: 'p1', plan_name: 'Upper/Lower',
  start_date: '2026-08-03', created_at: '2026-08-03T10:00:00Z', ...over,
});

describe('the ordering rule', () => {
  it('names all three columns, so a same-day tie can never be undecided', () => {
    expect(ACTIVE_ASSIGNMENT_ORDER).toContain('wa.start_date DESC');
    expect(ACTIVE_ASSIGNMENT_ORDER).toContain('wa.created_at DESC');
    expect(ACTIVE_ASSIGNMENT_ORDER).toContain('wa.id DESC');
  });

  it('sorts nulls last in the SQL, matching cmpDesc', () => {
    expect(ACTIVE_ASSIGNMENT_ORDER).toContain('wa.start_date DESC NULLS LAST');
    expect(cmpDesc(null, '2026-01-01')).toBeGreaterThan(0);
    expect(cmpDesc('2026-01-01', null)).toBeLessThan(0);
  });

  it('takes no caller input, so it can never carry an injection', () => {
    expect(ACTIVE_ASSIGNMENT_ORDER).not.toMatch(/\$\d|\$\{/);
  });
});

describe('selecting the active assignment', () => {
  it('is not ambiguous with one assignment', () => {
    const s = selectActiveAssignment([A()]);
    expect(s.chosen.id).toBe('a1');
    expect(s.ambiguous).toBe(false);
    expect(s.others).toEqual([]);
  });

  it('is not ambiguous with none — that is a client with no programme', () => {
    const s = selectActiveAssignment([]);
    expect(s.chosen).toBeNull();
    expect(s.ambiguous).toBe(false);
    expect(s.count).toBe(0);
  });

  it('prefers the most recently started programme', () => {
    const s = selectActiveAssignment([
      A({ id: 'old', start_date: '2026-06-01' }),
      A({ id: 'new', start_date: '2026-08-03' }),
    ]);
    expect(s.chosen.id).toBe('new');
    expect(s.ambiguous).toBe(true);
    expect(s.others.map((o) => o.id)).toEqual(['old']);
  });

  it('breaks a same-day tie on created_at, not on argument order', () => {
    const rows = [
      A({ id: 'first', created_at: '2026-08-03T09:00:00Z' }),
      A({ id: 'second', created_at: '2026-08-03T18:00:00Z' }),
    ];
    expect(selectActiveAssignment(rows).chosen.id).toBe('second');
    expect(selectActiveAssignment([...rows].reverse()).chosen.id).toBe('second');
  });

  it('breaks a same-transaction tie on id, so the answer is still total', () => {
    const rows = [
      A({ id: 'aaa', created_at: '2026-08-03T09:00:00Z' }),
      A({ id: 'zzz', created_at: '2026-08-03T09:00:00Z' }),
    ];
    expect(selectActiveAssignment(rows).chosen.id).toBe('zzz');
    expect(selectActiveAssignment([...rows].reverse()).chosen.id).toBe('zzz');
  });

  it('re-sorts, so a caller that forgot the ORDER BY still gets the same answer', () => {
    const unordered = [
      A({ id: 'old', start_date: '2026-06-01' }),
      A({ id: 'newest', start_date: '2026-09-01' }),
      A({ id: 'middle', start_date: '2026-08-03' }),
    ];
    expect(selectActiveAssignment(unordered).chosen.id).toBe('newest');
  });

  it('puts an assignment with no start date last, as NULLS LAST does', () => {
    const s = selectActiveAssignment([
      A({ id: 'undated', start_date: null }),
      A({ id: 'dated', start_date: '2026-01-01' }),
    ]);
    expect(s.chosen.id).toBe('dated');
  });

  // The regression that made this module necessary: node-postgres hands DATE
  // back as a JS Date, and `new Date('2026-08-03') > '2026-06-01'` is false in
  // both directions — so a comparator that did not normalise would report
  // every pair as equal and never reach the tie-break at all.
  it('orders Date objects from the driver, not just strings', () => {
    const s = selectActiveAssignment([
      A({ id: 'old', start_date: new Date('2026-06-01T00:00:00Z') }),
      A({ id: 'new', start_date: new Date('2026-08-03T00:00:00Z') }),
    ]);
    expect(s.chosen.id).toBe('new');
    expect(dayOf(new Date('2026-08-03T00:00:00Z'))).toBe('2026-08-03');
  });

  it('compares mixed Date and string start dates correctly', () => {
    expect(compareAssignments(
      A({ start_date: new Date('2026-08-03T00:00:00Z') }),
      A({ start_date: '2026-06-01' }),
    )).toBeLessThan(0);
  });

  it('reads created_at as a Date or a string alike', () => {
    expect(timeOf(new Date('2026-08-03T10:00:00Z'))).toBe(Date.parse('2026-08-03T10:00:00Z'));
    expect(timeOf('2026-08-03T10:00:00Z')).toBe(Date.parse('2026-08-03T10:00:00Z'));
    expect(timeOf('not a date')).toBeNull();
  });
});

describe('reporting the ambiguity rather than resolving it silently', () => {
  it('says nothing when there is nothing to say', () => {
    expect(ambiguityOf(selectActiveAssignment([A()]))).toBeNull();
    expect(ambiguityOf(selectActiveAssignment([]))).toBeNull();
  });

  it('names the count, the winner and every loser', () => {
    const amb = ambiguityOf(selectActiveAssignment([
      A({ id: 'a', plan_name: 'Upper/Lower', start_date: '2026-08-03' }),
      A({ id: 'b', plan_name: 'Full Body', start_date: '2026-07-01' }),
      A({ id: 'c', plan_name: 'Legacy', start_date: '2026-01-01' }),
    ]));
    expect(amb.active_count).toBe(3);
    expect(amb.chosen.plan_name).toBe('Upper/Lower');
    expect(amb.not_chosen.map((x) => x.plan_name)).toEqual(['Full Body', 'Legacy']);
    // The rule is stated to the trainer, not just applied to them.
    expect(amb.rule).toMatch(/most recently started/);
  });
});
