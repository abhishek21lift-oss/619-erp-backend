'use strict';

// The churn screen is the single source of truth for renewal, silence and
// dues. The queue must not re-derive them: a second scorer would drift, and a
// client hidden by the trainer on the churn screen would reappear here.

jest.mock('../modules/pt-os/churn.service', () => ({
  buildChurnList: jest.fn(),
  markFollowup: jest.fn(),
}));

const { buildChurnList } = require('../modules/pt-os/churn.service');
const churn = require('../modules/ai-ops/signals/churn');
const { dayDiff, formatDay, isYmd } = require('../modules/ai-ops/signals/dates');

const ORG = 'org-1';
const TODAY = '2026-11-25';

function fixture(over = {}) {
  return {
    client_id: 'c1',
    client_name: 'Ravi',
    days_quiet: 22,
    last_session: '2026-11-03',
    balance_amount: 4500,
    term: { state: 'current', end: '2026-11-30', days_left: 5 },
    score: 95,
    band: 'critical',
    reasons: [
      { code: 'silent_21', label: 'Last trained 22 days ago', points: 60 },
      { code: 'term_ending_7', label: 'Term ends in 5 days', points: 35 },
      { code: 'dues', label: 'Unpaid balance on file', points: 15 },
    ],
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('dates helpers', () => {
  it('counts whole days between YMD values', () => {
    expect(dayDiff('2026-11-03', '2026-11-25')).toBe(22);
    expect(dayDiff('2026-11-25', '2026-11-25')).toBe(0);
  });

  it('formats a short day label without a timezone shift', () => {
    expect(formatDay('2026-11-30')).toBe('30 Nov');
  });

  it('recognises only real YMD strings', () => {
    expect(isYmd('2026-11-30')).toBe(true);
    expect(isYmd('30 Nov')).toBe(false);
    expect(isYmd(null)).toBe(false);
  });
});

describe('churn signal adapter', () => {
  it('reads rows, never handled', async () => {
    buildChurnList.mockResolvedValue({
      rows: [fixture()],
      handled: [fixture({ client_id: 'hidden', client_name: 'Hidden' })],
    });

    const emitted = await churn.collect({ orgId: ORG, today: TODAY });

    expect(buildChurnList).toHaveBeenCalledWith(ORG, { today: TODAY });
    expect(emitted.map((e) => e.subject.id)).toEqual(['c1', 'c1', 'c1']);
    expect(emitted.some((e) => e.subject.id === 'hidden')).toBe(false);
  });

  it('emits one reason per churn reason with a plain subject', async () => {
    buildChurnList.mockResolvedValue({ rows: [fixture()], handled: [] });

    const emitted = await churn.collect({ orgId: ORG, today: TODAY });

    expect(emitted).toHaveLength(3);
    for (const entry of emitted) {
      expect(entry.subject).toEqual({ type: 'client', id: 'c1', name: 'Ravi', photo_url: null });
    }
    expect(emitted.map((e) => e.reason.code)).toEqual(['silent_21', 'term_ending_7', 'dues']);
  });

  it('keeps the day counter beside the evidence, not inside it', async () => {
    buildChurnList.mockResolvedValue({ rows: [fixture()], handled: [] });

    const emitted = await churn.collect({ orgId: ORG, today: TODAY });
    const silent = emitted.find((e) => e.reason.code === 'silent_21');

    expect(silent.reason.evidence).toEqual({ last_session: '2026-11-03' });
    expect(silent.reason.days_quiet).toBe(22);
  });

  it('maps the term end date to evidence and the due date', async () => {
    buildChurnList.mockResolvedValue({ rows: [fixture()], handled: [] });

    const emitted = await churn.collect({ orgId: ORG, today: TODAY });
    const term = emitted.find((e) => e.reason.code === 'term_ending_7');

    expect(term.reason.evidence).toEqual({ pt_end_date: '2026-11-30' });
    expect(term.reason.due_at).toBe('2026-11-30');
  });

  it('formats the dues label as Indian-grouped rupees', async () => {
    buildChurnList.mockResolvedValue({ rows: [fixture()], handled: [] });

    const emitted = await churn.collect({ orgId: ORG, today: TODAY });
    const dues = emitted.find((e) => e.reason.code === 'dues');

    expect(dues.reason.evidence).toEqual({ balance_amount: 4500 });
    expect(dues.reason.label).toBe('₹4,500 overdue');
    expect(dues.reason.due_at).toBeNull();
  });

  it('gives a term that already ended no due date', async () => {
    buildChurnList.mockResolvedValue({
      rows: [fixture({
        term: { state: 'ended', end: '2026-11-01', days_left: -24 },
        reasons: [{ code: 'term_ended', label: 'Term ended 24 days ago', points: 20 }],
      })],
      handled: [],
    });

    const emitted = await churn.collect({ orgId: ORG, today: TODAY });

    expect(emitted[0].reason.code).toBe('term_ended');
    expect(emitted[0].reason.due_at).toBeNull();
  });

  it('drops a code the catalog does not know instead of crashing', async () => {
    buildChurnList.mockResolvedValue({
      rows: [fixture({
        reasons: [
          { code: 'silent_21', label: 'Last trained 22 days ago', points: 60 },
          { code: 'mystery_reason', label: '???', points: 99 },
        ],
      })],
      handled: [],
    });

    const emitted = await churn.collect({ orgId: ORG, today: TODAY });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].reason.code).toBe('silent_21');
  });
});
