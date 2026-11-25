'use strict';

// Lead follow-ups. `lead_due` is a date the trainer chose; `lead_stale` is the
// absence of one. Only unconverted, un-lost leads with status new/contacted can
// be stale in v1 — a scheduled trial has its own date and is not chased here.

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ query: mockQuery }));

const leads = require('../modules/ai-ops/signals/leads');

const ORG = 'org-1';
const TODAY = '2026-11-25';

beforeEach(() => { mockQuery.mockReset(); });

const row = (over = {}) => ({
  id: 'l1',
  name: 'Priya',
  mobile: '+919000000002',
  status: 'new',
  follow_up_date: null,
  created_at: '2026-11-21T09:00:00.000Z',
  ...over,
});

describe('lead mapper', () => {
  it('emits a follow-up that is due today', () => {
    const emitted = leads.reasonsFromLeads([row({ follow_up_date: TODAY })], TODAY);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].subject).toEqual({ type: 'lead', id: 'l1', name: 'Priya', photo_url: null });
    expect(emitted[0].reason).toEqual({
      code: 'lead_due',
      label: 'Follow-up due today',
      evidence: { follow_up_date: TODAY },
      due_at: TODAY,
    });
  });

  it('emits an overdue follow-up for every open status', () => {
    for (const status of ['new', 'contacted', 'trial_scheduled']) {
      const emitted = leads.reasonsFromLeads([row({ status, follow_up_date: '2026-11-23' })], TODAY);
      expect(emitted[0].reason.code).toBe('lead_due');
      expect(emitted[0].reason.label).toBe('Follow-up was due 23 Nov');
    }
  });

  it('flags a lead with no follow-up after three days', () => {
    const emitted = leads.reasonsFromLeads([row()], TODAY);

    expect(emitted[0].reason.code).toBe('lead_stale');
    expect(emitted[0].reason.evidence).toEqual({ created_at: '2026-11-21' });
    expect(emitted[0].reason.due_at).toBeNull();
  });

  it('does not flag a three-day-old lead yet', () => {
    expect(leads.reasonsFromLeads([row({ created_at: '2026-11-22T09:00:00.000Z' })], TODAY)).toEqual([]);
  });

  it('never emits for converted or lost leads', () => {
    for (const status of ['converted', 'lost']) {
      expect(leads.reasonsFromLeads([row({ status, follow_up_date: '2026-11-01' })], TODAY)).toEqual([]);
    }
  });

  it('does not call a scheduled trial stale just because it has no follow-up', () => {
    expect(leads.reasonsFromLeads([row({ status: 'trial_scheduled' })], TODAY)).toEqual([]);
  });
});

describe('lead collect', () => {
  it('runs a tenant-scoped query and maps rows', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ follow_up_date: TODAY })] });

    const emitted = await leads.collect({ orgId: ORG, today: TODAY });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('organization_id = $1');
    expect(params[0]).toBe(ORG);
    expect(emitted[0].reason.code).toBe('lead_due');
  });
});
