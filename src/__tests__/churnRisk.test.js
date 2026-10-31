'use strict';
const { scoreClient, rankClients, bandFor, WEIGHTS } = require('../modules/pt-os/churn-risk');

const term = (days_left) => ({
  state: days_left < 0 ? 'ended' : 'current',
  end: '2026-11-14',
  days_left,
});
const score = (o = {}) => scoreClient({
  days_quiet: null, never_started: false, flagged: true,
  term: term(90), balance_amount: 0, ...o,
});

describe('scoreClient', () => {
  it('silence of 21+ days is critical on its own', () => {
    expect(score({ days_quiet: 21 })).toMatchObject({ score: 60, band: 'critical' });
    expect(score({ days_quiet: 45 }).score).toBe(60);
  });

  it('silence of 10-20 days is 25 and medium', () => {
    expect(score({ days_quiet: 10 })).toMatchObject({ score: 25, band: 'medium' });
    expect(score({ days_quiet: 20 }).score).toBe(25);
  });

  it('never started is critical regardless of last session', () => {
    expect(score({ never_started: true, days_quiet: null }))
      .toMatchObject({ score: 60, band: 'critical' });
  });

  it('never started and silence never stack', () => {
    expect(score({ never_started: true, days_quiet: 45 }).score).toBe(60);
  });

  it('adds term and money pressure', () => {
    expect(score({ days_quiet: 21, term: term(5), balance_amount: 8000 }).score).toBe(100);
  });

  it('scores a term ending today as ending, not ended', () => {
    expect(score({ days_quiet: null, term: term(0) }).reasons.map((r) => r.code))
      .toEqual(['term_ending_7']);
  });

  it('scores an ended term only when the sweep also flagged the client', () => {
    expect(score({ flagged: false, term: term(-3) }).score).toBe(0);
    expect(score({ flagged: true, term: term(-3) })).toMatchObject({ score: 20, band: 'medium' });
    expect(score({ flagged: true, term: term(-3) }).reasons[0].code).toBe('term_ended');
  });

  it('treats a missing or malformed term as unknown', () => {
    expect(score({ term: null }).score).toBe(0);
    expect(score({ term: { state: 'unknown', end: null, days_left: null } }).score).toBe(0);
  });

  it('adds dues only when the balance is positive', () => {
    expect(score({ balance_amount: '8000' }).reasons).toEqual([
      expect.objectContaining({ code: 'dues', points: 15 }),
    ]);
    expect(score({ balance_amount: '0' }).score).toBe(0);
  });

  it('clamps at 100', () => {
    expect(score({ never_started: true, term: term(5), balance_amount: 8000 }).score).toBe(100);
  });

  it('returns reasons with points and a label that carries the number', () => {
    const r = score({ days_quiet: 31, balance_amount: 8000 });
    expect(r.reasons[0]).toEqual({ code: 'silent_21', label: 'Last trained 31 days ago', points: 60 });
    expect(r.reasons[1].code).toBe('dues');
  });

  it('first matching action wins by priority, not by points', () => {
    expect(score({ days_quiet: 12, balance_amount: 8000 }).next_action)
      .toMatch(/before the gap becomes a habit/);
    expect(score({ days_quiet: 30, term: term(-2) }).next_action)
      .toMatch(/paying for training they are not taking/);
    expect(score({ term: term(5), balance_amount: 8000 }).next_action)
      .toMatch(/before the term lapses/);
  });
});

describe('bandFor', () => {
  it.each([[0, null], [1, 'low'], [14, 'low'], [15, 'medium'], [34, 'medium'],
    [35, 'high'], [59, 'high'], [60, 'critical'], [100, 'critical']])('%i -> %s', (n, band) => {
    expect(bandFor(n)).toBe(band);
  });
});

describe('rankClients', () => {
  it('sorts by score, then never-trained as the longest silence, then name', () => {
    const rows = [
      { client_name: 'B', score: 60, days_quiet: 21, reasons: [{ code: 'silent_21' }] },
      { client_name: 'A', score: 60, days_quiet: 21, reasons: [{ code: 'silent_21' }] },
      { client_name: 'N', score: 60, days_quiet: null, reasons: [{ code: 'never_started' }] },
      { client_name: 'D', score: 15, days_quiet: null, reasons: [{ code: 'dues' }] },
    ];
    expect(rankClients(rows).map((r) => r.client_name)).toEqual(['N', 'A', 'B', 'D']);
    expect(rows[0].client_name).toBe('B');
  });
});

it('weights are the contract', () => {
  expect(WEIGHTS).toEqual({
    never_started: 60, silent_21: 60, silent_10: 25,
    term_ending_7: 35, term_ending_30: 15, term_ended: 20, dues: 15,
  });
});
