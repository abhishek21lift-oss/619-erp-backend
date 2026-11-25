'use strict';

// The registry is the only place points and families are attached, and the
// only place a failing collector is contained. A screening query outage must
// not hide a renewal: one rejected collector is logged and skipped.

jest.mock('../lib/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../modules/ai-ops/signals/churn', () => ({ collect: jest.fn() }));
jest.mock('../modules/ai-ops/signals/activity', () => ({ collect: jest.fn() }));
jest.mock('../modules/ai-ops/signals/checkins', () => ({ collect: jest.fn() }));
jest.mock('../modules/ai-ops/signals/screening', () => ({ collect: jest.fn() }));
jest.mock('../modules/ai-ops/signals/formChecks', () => ({ collect: jest.fn() }));
jest.mock('../modules/ai-ops/signals/leads', () => ({ collect: jest.fn() }));

const churn = require('../modules/ai-ops/signals/churn');
const activity = require('../modules/ai-ops/signals/activity');
const checkins = require('../modules/ai-ops/signals/checkins');
const screening = require('../modules/ai-ops/signals/screening');
const formChecks = require('../modules/ai-ops/signals/formChecks');
const leads = require('../modules/ai-ops/signals/leads');
const logger = require('../lib/logger');
const { collectAll } = require('../modules/ai-ops/signals');

const ORG = 'org-1';
const TODAY = '2026-11-25';

const c1 = { type: 'client', id: 'c1', name: 'Ravi', photo_url: null };
const c2 = { type: 'client', id: 'c2', name: 'Amit', photo_url: null };
const l1 = { type: 'lead', id: 'l1', name: 'Priya', photo_url: null };

beforeEach(() => {
  jest.clearAllMocks();
  activity.collect.mockResolvedValue([]);
  formChecks.collect.mockResolvedValue([]);
  churn.collect.mockResolvedValue([
    { subject: c1, reason: { code: 'silent_10', label: 'Last trained 12 days ago', evidence: { last_session: '2026-11-13' }, due_at: null, days_quiet: 12 } },
    { subject: c1, reason: { code: 'dues', label: '₹4,500 overdue', evidence: { balance_amount: 4500 }, due_at: null } },
  ]);
  checkins.collect.mockResolvedValue([
    { subject: c1, reason: { code: 'checkin_missing_7', label: 'No check-in for 8 days', evidence: { last_checkin: '2026-11-17' }, due_at: null } },
    { subject: c1, reason: { code: 'silent_10', label: 'Duplicate', evidence: { last_session: '2026-11-13' }, due_at: null } },
  ]);
  screening.collect.mockResolvedValue([
    { subject: c2, reason: { code: 'parq_missing', label: 'No PAR-Q on file', evidence: { parq_id: null }, due_at: null } },
  ]);
  leads.collect.mockResolvedValue([
    { subject: l1, reason: { code: 'lead_due', label: 'Follow-up due today', evidence: { follow_up_date: TODAY }, due_at: TODAY } },
  ]);
});

describe('collectAll', () => {
  it('groups emissions by subject and attaches catalog points and family', async () => {
    const groups = await collectAll({ orgId: ORG, today: TODAY });

    expect(groups.map((g) => `${g.subject.type}:${g.subject.id}`))
      .toEqual(['client:c1', 'lead:l1', 'client:c2']);

    const group = groups.find((g) => g.subject.id === 'c1');
    expect(group.reasons.map((r) => r.code)).toEqual(['silent_10', 'dues', 'checkin_missing_7']);
    expect(group.reasons.map((r) => r.points)).toEqual([25, 15, 15]);
    expect(group.reasons.map((r) => r.family)).toEqual(['churn', 'churn', 'engagement']);
  });

  it('de-duplicates a reason emitted by two collectors', async () => {
    const groups = await collectAll({ orgId: ORG, today: TODAY });
    const group = groups.find((g) => g.subject.id === 'c1');
    expect(group.reasons.filter((r) => r.code === 'silent_10')).toHaveLength(1);
  });

  it('computes the group score, band and next due date', async () => {
    const groups = await collectAll({ orgId: ORG, today: TODAY });

    const c1Group = groups.find((g) => g.subject.id === 'c1');
    expect(c1Group.score).toBe(55);
    expect(c1Group.band).toBe('high');

    const l1Group = groups.find((g) => g.subject.id === 'l1');
    expect(l1Group.next_due_at).toBe('2026-11-25T00:00:00.000Z');
  });

  it('returns plain subjects, never raw rows', async () => {
    const groups = await collectAll({ orgId: ORG, today: TODAY });
    for (const group of groups) {
      expect(Object.keys(group.subject).sort()).toEqual(['id', 'name', 'photo_url', 'type']);
    }
  });

  it('drops an emission with no subject id or an unknown code', async () => {
    leads.collect.mockResolvedValue([
      { subject: { type: 'lead', id: null, name: 'Ghost', photo_url: null }, reason: { code: 'lead_due' } },
      { subject: l1, reason: { code: 'mystery', label: '???', evidence: {} } },
    ]);

    const groups = await collectAll({ orgId: ORG, today: TODAY });
    expect(groups.find((g) => g.subject.id === 'l1')).toBeUndefined();
  });

  it('contains a failing collector and keeps the rest', async () => {
    churn.collect.mockRejectedValue(new Error('churn query failed'));

    const groups = await collectAll({ orgId: ORG, today: TODAY });

    expect(groups.map((g) => g.subject.id)).toEqual(['c1', 'l1', 'c2']);
    expect(logger.warn).toHaveBeenCalled();
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('ai_ops_signal_failed');
    expect(logged).toContain('churn');
    expect(logged).toContain('churn query failed');
  });
});
