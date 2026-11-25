'use strict';

// The queue's priority is a deterministic contract, not a model output.
// These tests pin the catalog, the one scale shared with the churn screen,
// and the reopen identity that stops a dismissed item returning every morning.

const {
  FAMILY, POINTS, MESSAGE_CODES, bandFor, dedupeReasons, scoreReasons,
  compareItems, evidenceHash, reasonIdentity, closedReasons, shouldReopen,
  chooseAction, firstName,
} = require('../modules/ai-ops/priority');
const { WEIGHTS } = require('../modules/pt-os/churn-risk');

const codes = [
  'never_started', 'silent_21', 'silent_10', 'term_ending_7',
  'term_ending_30', 'term_ended', 'dues', 'no_show_recent',
  'form_check_pending', 'checkin_missing_7', 'checkin_missing_14',
  'parq_missing', 'consent_missing', 'clearance_expired',
  'lead_due', 'lead_stale',
];

describe('ai-ops priority catalog', () => {
  it('has exactly the sixteen v1 reason codes', () => {
    expect(Object.keys(POINTS).sort()).toEqual([...codes].sort());
    expect(Object.keys(FAMILY).sort()).toEqual([...codes].sort());
  });

  it('uses the churn screen weights verbatim for churn reasons', () => {
    for (const [code, points] of Object.entries(WEIGHTS)) {
      expect(POINTS[code]).toBe(points);
    }
  });

  it('assigns the documented points and families', () => {
    expect(POINTS).toMatchObject({
      never_started: 60, silent_21: 60, silent_10: 25,
      term_ending_7: 35, term_ending_30: 15, term_ended: 20, dues: 15,
      no_show_recent: 20, form_check_pending: 20,
      checkin_missing_7: 15, checkin_missing_14: 25,
      parq_missing: 25, consent_missing: 15, clearance_expired: 35,
      lead_due: 30, lead_stale: 20,
    });
    expect(FAMILY).toMatchObject({
      never_started: 'churn', dues: 'churn', checkin_missing_7: 'engagement',
      no_show_recent: 'training', form_check_pending: 'training',
      parq_missing: 'screening', clearance_expired: 'screening',
      lead_due: 'leads',
    });
  });

  it('marks only the client-facing reasons as message codes', () => {
    expect([...MESSAGE_CODES].sort()).toEqual([
      'checkin_missing_14', 'checkin_missing_7', 'dues', 'lead_due', 'lead_stale',
      'never_started', 'no_show_recent', 'silent_10', 'silent_21',
      'term_ended', 'term_ending_30', 'term_ending_7',
    ].sort());
    for (const internal of ['form_check_pending', 'parq_missing', 'consent_missing', 'clearance_expired']) {
      expect(MESSAGE_CODES).not.toContain(internal);
    }
  });
});

describe('scoreReasons', () => {
  it('sums distinct codes and caps at 100', () => {
    const scored = scoreReasons([
      { code: 'never_started' }, { code: 'silent_21' }, { code: 'dues' },
      { code: 'never_started' },
    ]);
    expect(scored.score).toBe(100);
    expect(scored.band).toBe('critical');
  });

  it('maps the band boundaries', () => {
    expect(bandFor(60)).toBe('critical');
    expect(bandFor(59)).toBe('high');
    expect(bandFor(35)).toBe('high');
    expect(bandFor(34)).toBe('medium');
    expect(bandFor(15)).toBe('medium');
    expect(bandFor(14)).toBe('low');
    expect(bandFor(1)).toBe('low');
    expect(bandFor(0)).toBe('low');
  });

  it('takes the earliest due date and normalises it to ISO', () => {
    const scored = scoreReasons([
      { code: 'term_ending_30', due_at: '2026-12-10' },
      { code: 'term_ending_7', due_at: '2026-11-28' },
      { code: 'dues', due_at: null },
    ]);
    expect(scored.next_due_at).toBe('2026-11-28T00:00:00.000Z');
    expect(scoreReasons([{ code: 'dues' }]).next_due_at).toBeNull();
  });

  it('keeps the first occurrence of a duplicated code', () => {
    const deduped = dedupeReasons([
      { code: 'dues', label: 'first' },
      { code: 'dues', label: 'second' },
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].label).toBe('first');
  });

  it('does not mutate its input', () => {
    const input = [{ code: 'dues' }];
    scoreReasons(input);
    expect(input).toEqual([{ code: 'dues' }]);
  });
});

describe('compareItems', () => {
  const item = (over = {}) => ({
    priority_score: 50,
    next_due_at: null,
    subject: { name: 'Ravi' },
    reasons: [],
    ...over,
  });

  it('orders by score descending first', () => {
    const rows = [item({ priority_score: 15 }), item({ priority_score: 60 })];
    expect([...rows].sort(compareItems).map((r) => r.priority_score)).toEqual([60, 15]);
  });

  it('breaks ties by earliest due date, nulls last', () => {
    const rows = [
      item({ subject: { name: 'No due' } }),
      item({ next_due_at: '2026-12-10T00:00:00.000Z', subject: { name: 'Later' } }),
      item({ next_due_at: '2026-11-28T00:00:00.000Z', subject: { name: 'Sooner' } }),
    ];
    expect([...rows].sort(compareItems).map((r) => r.subject.name)).toEqual([
      'Sooner', 'Later', 'No due',
    ]);
  });

  it('breaks ties by longest silence, nulls last', () => {
    const rows = [
      item({ subject: { name: 'Fresh' }, reasons: [{ code: 'silent_10', days_quiet: 10 }] }),
      item({ subject: { name: 'Quiet' }, reasons: [{ code: 'silent_21', days_quiet: 30 }] }),
      item({ subject: { name: 'Unknown' } }),
    ];
    expect([...rows].sort(compareItems).map((r) => r.subject.name)).toEqual([
      'Quiet', 'Fresh', 'Unknown',
    ]);
  });

  it('breaks the final tie by name ascending', () => {
    const rows = [item({ subject: { name: 'Zara' } }), item({ subject: { name: 'Amit' } })];
    expect([...rows].sort(compareItems).map((r) => r.subject.name)).toEqual(['Amit', 'Zara']);
  });
});

describe('reopen identity', () => {
  it('hashes evidence independently of key order', () => {
    expect(evidenceHash({ a: 1, b: 2 })).toBe(evidenceHash({ b: 2, a: 1 }));
    expect(evidenceHash({ a: 1 })).not.toBe(evidenceHash({ a: 2 }));
  });

  it('ignores the label and the day counter', () => {
    const monday = { code: 'silent_21', label: 'Last trained 21 days ago', evidence: { last_session: '2026-11-04' }, days_quiet: 21 };
    const tuesday = { ...monday, label: 'Last trained 22 days ago', days_quiet: 22 };
    expect(reasonIdentity(monday)).toBe(reasonIdentity(tuesday));
  });

  it('reopens when a code is new, evidence changes, or score rises 15', () => {
    const reasons = [
      { code: 'dues', evidence: { balance_amount: 4500 } },
      { code: 'term_ending_7', evidence: { pt_end_date: '2026-11-30' } },
    ];
    const closed = closedReasons(reasons);
    const base = { closed_reasons: closed, closed_score: 50 };

    expect(shouldReopen(reasons, base)).toBe(false);
    expect(shouldReopen([...reasons, { code: 'silent_10', evidence: {} }], base)).toBe(true);
    expect(shouldReopen([
      { code: 'dues', evidence: { balance_amount: 3000 } },
      reasons[1],
    ], base)).toBe(true);
    expect(shouldReopen(reasons, { ...base, closed_score: 35 })).toBe(true);
    expect(shouldReopen(reasons, { ...base, closed_score: 36 })).toBe(false);
  });

  it('never reopens when every reason cleared', () => {
    expect(shouldReopen([], { closed_reasons: [], closed_score: 100 })).toBe(false);
  });
});

describe('chooseAction', () => {
  it('picks the highest-points executable reason', () => {
    const action = chooseAction(
      [{ code: 'dues' }, { code: 'form_check_pending' }],
      { type: 'client', id: 'c1' },
    );
    expect(action).toEqual({
      kind: 'internal', label: 'Review form check', href: '/pt-os/form-checks',
      reason_code: 'form_check_pending',
    });
  });

  it('sends a message for dues when no higher internal action exists', () => {
    const action = chooseAction([{ code: 'dues' }], { type: 'client', id: 'c1' });
    expect(action).toEqual({
      kind: 'message', label: 'Send payment reminder', href: null, reason_code: 'dues',
    });
  });

  it('deep-links screening to the client, never to model-provided hrefs', () => {
    const action = chooseAction([{ code: 'clearance_expired' }], { type: 'client', id: 'c1' });
    expect(action).toEqual({
      kind: 'internal', label: 'Open screening', href: '/pt-os/clients/c1',
      reason_code: 'clearance_expired',
    });
  });

  it('sends a follow-up for leads', () => {
    const action = chooseAction([{ code: 'lead_due' }], { type: 'lead', id: 'l1' });
    expect(action).toEqual({
      kind: 'message', label: 'Send follow-up', href: null, reason_code: 'lead_due',
    });
  });

  it('falls back to a review link for an unknown reason', () => {
    const action = chooseAction([{ code: 'mystery' }], { type: 'client', id: 'c1' });
    expect(action.kind).toBe('internal');
    expect(action.href).toBe('/pt-os/clients/c1');
  });
});

describe('firstName', () => {
  it('keeps a normal first name', () => {
    expect(firstName('Ravi Kumar')).toBe('Ravi');
  });

  it('strips control characters and markup and caps the length', () => {
    expect(firstName('Ravi\n<script>alert(1)</script>')).not.toMatch(/[<>\n]/);
    expect(firstName('A'.repeat(100))).toHaveLength(40);
  });

  it('falls back when there is no usable name', () => {
    expect(firstName('   ')).toBe('there');
    expect(firstName(null)).toBe('there');
  });
});
