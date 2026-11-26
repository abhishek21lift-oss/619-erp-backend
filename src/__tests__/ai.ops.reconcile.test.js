'use strict';

// Reconciliation is where a deterministic signal becomes a durable item with a
// lifecycle. These tests pin every transition in the design's table, because
// the expensive bugs are lifecycle bugs: an approved item coming back, a
// dismissed item returning every morning, or a snooze that never expires.

jest.mock('../modules/ai-ops/ops.repository');
jest.mock('../modules/ai-ops/signals', () => ({ collectAll: jest.fn() }));
jest.mock('../modules/ai-ops/templates', () => ({ templateDraft: jest.fn() }));
jest.mock('../modules/messaging/transport', () => ({ resolveInstance: jest.fn() }));

const repo = require('../modules/ai-ops/ops.repository');
const { collectAll } = require('../modules/ai-ops/signals');
const { templateDraft } = require('../modules/ai-ops/templates');
const transport = require('../modules/messaging/transport');
const ops = require('../modules/ai-ops/ops.service');
const { reasonIdentity, closedReasons } = require('../modules/ai-ops/priority');

const ORG = 'org-1';
const TODAY = '2026-11-25';
const NOW = new Date('2026-11-25T09:00:00.000Z');

const subject = { type: 'client', id: 'c1', name: 'Ravi', photo_url: null };

const dues = {
  code: 'dues', label: '₹4,500 overdue', points: 15, family: 'churn',
  evidence: { balance_amount: 4500 }, due_at: null,
};

function group(over = {}) {
  return {
    subject,
    reasons: [dues],
    score: 15,
    band: 'medium',
    next_due_at: null,
    ...over,
  };
}

const action = { kind: 'message', label: 'Send payment reminder', href: null, reason_code: 'dues' };

function item(over = {}) {
  return {
    id: 'i1',
    organization_id: ORG,
    client_id: 'c1',
    lead_id: null,
    dedupe_key: 'client:c1',
    status: 'open',
    priority_score: 15,
    priority_band: 'medium',
    reasons: [dues],
    next_due_at: null,
    recommended_action: action,
    draft: null,
    closed_reasons: [],
    closed_score: 0,
    snoozed_until: null,
    dismissed_reason: null,
    last_contacted_at: null,
    last_actioned_at: null,
    last_error: null,
    resolved_at: null,
    created_at: '2026-11-20T09:00:00.000Z',
    ...over,
  };
}

function openRow(over = {}) {
  return {
    ...item(),
    subject_type: 'client',
    subject_name: 'Ravi',
    photo_url: null,
    mobile: '+919000000001',
    whatsapp_opt_out: false,
    lead_mobile: null,
    ...over,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  collectAll.mockResolvedValue([]);
  repo.findItems.mockResolvedValue([]);
  repo.insertItem.mockResolvedValue({ id: 'i1' });
  repo.insertEvent.mockResolvedValue('evt-1');
  repo.updateItem.mockResolvedValue({ id: 'i1' });
  repo.reopenActionedItem.mockResolvedValue({ id: 'i1' });
  repo.reopenClosedItem.mockResolvedValue({ id: 'i1' });
  repo.resolveMissingItem.mockResolvedValue({ id: 'i1' });
  repo.orgName.mockResolvedValue('Iron House');
  repo.findOpenItems.mockResolvedValue([]);
  repo.latestBrief.mockResolvedValue(null);
  transport.resolveInstance.mockResolvedValue({ ok: true });
  templateDraft.mockReturnValue({
    body: 'Hi Ravi, a balance of ₹4,500 is pending on your training account.',
    channel: 'whatsapp', source: 'template', model: null,
    generated_at: NOW.toISOString(), confidence: null, reason_key: reasonIdentity(dues),
  });
});

describe('reconcile — new and unchanged items', () => {
  it('creates a new item and a created event', async () => {
    collectAll.mockResolvedValue([group()]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.insertItem).toHaveBeenCalledWith(ORG, expect.objectContaining({
      client_id: 'c1', lead_id: null, dedupe_key: 'client:c1', status: 'open',
      priority_score: 15, priority_band: 'medium', closed_reasons: [], closed_score: 0,
    }));
    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      itemId: 'i1', eventType: 'created', payload: { reason_codes: ['dues'] },
    }));
  });

  it('does not rewrite or re-audit an unchanged open item', async () => {
    collectAll.mockResolvedValue([group()]);
    repo.findItems.mockResolvedValue([item()]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.updateItem).not.toHaveBeenCalled();
    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it('rewrites labels without an event when only the label changed', async () => {
    collectAll.mockResolvedValue([group({
      reasons: [{ ...dues, label: '₹4,500 still overdue' }],
    })]);
    repo.findItems.mockResolvedValue([item()]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.updateItem).toHaveBeenCalledWith(
      ORG, 'i1', 'open', expect.objectContaining({ reasons: [expect.objectContaining({ label: '₹4,500 still overdue' })] }),
    );
    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it('updates and audits when the evidence changed', async () => {
    collectAll.mockResolvedValue([group({
      reasons: [{ ...dues, evidence: { balance_amount: 6000 } }],
    })]);
    repo.findItems.mockResolvedValue([item()]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.updateItem).toHaveBeenCalledWith(ORG, 'i1', 'open', expect.any(Object));
    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      eventType: 'reasons_updated', payload: { from: ['dues'], to: ['dues'] },
    }));
  });

  it('resolves a collected item that disappeared', async () => {
    collectAll.mockResolvedValue([]);
    repo.findItems.mockResolvedValue([item()]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.resolveMissingItem).toHaveBeenCalledWith(ORG, 'i1');
    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      eventType: 'resolved', payload: { auto: true },
    }));
  });

  it('never resolves a dismissed item that is not collected', async () => {
    collectAll.mockResolvedValue([]);
    repo.findItems.mockResolvedValue([item({ status: 'dismissed', closed_reasons: closedReasons([dues]), closed_score: 15 })]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.resolveMissingItem).not.toHaveBeenCalled();
  });

  it('does not resurrect an item when the guarded write loses a race', async () => {
    collectAll.mockResolvedValue([group({ reasons: [{ ...dues, evidence: { balance_amount: 6000 } }] })]);
    repo.findItems.mockResolvedValue([item()]);
    repo.updateItem.mockResolvedValue(null);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it('de-duplicates two groups for the same subject defensively', async () => {
    collectAll.mockResolvedValue([group(), group()]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.insertItem).toHaveBeenCalledTimes(1);
    expect(repo.insertEvent).toHaveBeenCalledTimes(1);
  });
});

describe('reconcile — snoozed', () => {
  it('keeps a future snooze hidden and refreshes its reasons', async () => {
    collectAll.mockResolvedValue([group()]);
    repo.findItems.mockResolvedValue([item({
      status: 'snoozed',
      snoozed_until: '2026-11-26T09:00:00.000Z',
    })]);

    const queue = await ops.getQueue({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.updateItem).toHaveBeenCalledWith(ORG, 'i1', 'snoozed', expect.any(Object));
    expect(repo.insertEvent).not.toHaveBeenCalled();
    expect(queue.items).toEqual([]);
  });

  it('reopens a snooze whose time has passed', async () => {
    collectAll.mockResolvedValue([group()]);
    repo.findItems.mockResolvedValue([item({
      status: 'snoozed',
      snoozed_until: '2026-11-24T09:00:00.000Z',
    })]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.updateItem).toHaveBeenCalledWith(ORG, 'i1', 'snoozed', expect.objectContaining({
      status: 'open', snoozed_until: null,
    }));
    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      eventType: 'reopened', payload: { trigger: 'snooze_elapsed', from: 'snoozed' },
    }));
  });

  it('resolves a snoozed item that is no longer collected', async () => {
    repo.findItems.mockResolvedValue([item({ status: 'snoozed', snoozed_until: '2026-11-26T09:00:00.000Z' })]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.resolveMissingItem).toHaveBeenCalledWith(ORG, 'i1');
  });
});

describe('reconcile — actioned', () => {
  it('leaves a recently actioned item alone', async () => {
    collectAll.mockResolvedValue([group()]);
    repo.findItems.mockResolvedValue([item({
      status: 'actioned',
      last_actioned_at: '2026-11-23T09:00:00.000Z',
    })]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.reopenActionedItem).not.toHaveBeenCalled();
    expect(repo.updateItem).not.toHaveBeenCalled();
    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it('reopens after seven days when the reasons persist', async () => {
    collectAll.mockResolvedValue([group()]);
    repo.findItems.mockResolvedValue([item({
      status: 'actioned',
      last_actioned_at: '2026-11-17T09:00:00.000Z',
    })]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.reopenActionedItem).toHaveBeenCalledWith(ORG, 'i1', expect.any(Object));
    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      eventType: 'reopened', payload: { trigger: 'seven_days', from: 'actioned' },
    }));
  });

  it('resolves an actioned item that is no longer collected', async () => {
    repo.findItems.mockResolvedValue([item({
      status: 'actioned',
      last_actioned_at: '2026-11-17T09:00:00.000Z',
    })]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.resolveMissingItem).toHaveBeenCalledWith(ORG, 'i1');
  });
});

describe('reconcile — dismissed and resolved', () => {
  const dismissed = (over = {}) => item({
    status: 'dismissed',
    closed_reasons: closedReasons([dues]),
    closed_score: 15,
    ...over,
  });

  it('keeps a dismissed item dismissed when nothing changed', async () => {
    collectAll.mockResolvedValue([group()]);
    repo.findItems.mockResolvedValue([dismissed()]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.reopenClosedItem).not.toHaveBeenCalled();
  });

  it('reopens on changed evidence', async () => {
    collectAll.mockResolvedValue([group({
      reasons: [{ ...dues, evidence: { balance_amount: 3000 } }],
    })]);
    repo.findItems.mockResolvedValue([dismissed()]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.reopenClosedItem).toHaveBeenCalledWith(ORG, 'i1', 'dismissed', expect.any(Object));
    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      eventType: 'reopened', payload: { trigger: 'evidence', from: 'dismissed' },
    }));
  });

  it('reopens on a new reason code', async () => {
    collectAll.mockResolvedValue([group({
      reasons: [dues, {
        code: 'term_ending_30', label: 'Term ends in 20 days', points: 15,
        family: 'churn', evidence: { pt_end_date: '2026-12-15' }, due_at: '2026-12-15',
      }],
      score: 30,
      band: 'medium',
    })]);
    repo.findItems.mockResolvedValue([dismissed()]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.reopenClosedItem).toHaveBeenCalled();
  });

  it('reopens when the score rose by fifteen even with identical evidence', async () => {
    collectAll.mockResolvedValue([group({ score: 30, band: 'medium' })]);
    repo.findItems.mockResolvedValue([dismissed()]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      eventType: 'reopened', payload: { trigger: 'score', from: 'dismissed' },
    }));
  });

  it('does not reopen at a fourteen point rise', async () => {
    collectAll.mockResolvedValue([group()]);
    repo.findItems.mockResolvedValue([dismissed({ closed_score: 1 })]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.reopenClosedItem).not.toHaveBeenCalled();
  });

  it('reopens a resolved item when a new balance appears', async () => {
    collectAll.mockResolvedValue([group({
      reasons: [{ ...dues, evidence: { balance_amount: 4500 } }],
    })]);
    repo.findItems.mockResolvedValue([item({
      status: 'resolved',
      closed_reasons: closedReasons([{ ...dues, evidence: { balance_amount: 3000 } }]),
      closed_score: 15,
    })]);

    await ops.reconcile({ orgId: ORG, today: TODAY, now: NOW });

    expect(repo.reopenClosedItem).toHaveBeenCalledWith(ORG, 'i1', 'resolved', expect.any(Object));
  });
});

describe('getQueue', () => {
  it('returns the documented response shape', async () => {
    repo.findOpenItems.mockResolvedValue([openRow()]);

    const queue = await ops.getQueue({ orgId: ORG, today: TODAY, now: NOW });

    expect(queue).toMatchObject({
      brief: null,
      ai: { status: 'not_generated', message: 'No brief yet today.', last_generated_at: null },
      counts: {
        total: 1,
        by_band: { critical: 0, high: 0, medium: 1, low: 0 },
        by_family: { churn: 1, engagement: 0, training: 0, screening: 0, leads: 0 },
      },
    });
    expect(Number.isFinite(Date.parse(queue.as_of))).toBe(true);
    expect(queue.items[0].subject).toEqual({ type: 'client', id: 'c1', name: 'Ravi', photo_url: null });
  });

  it('counts an item in every family it belongs to', async () => {
    repo.findOpenItems.mockResolvedValue([openRow({
      reasons: [
        dues,
        { code: 'form_check_pending', label: 'Form check waiting 30 hours', points: 20, family: 'training', evidence: {}, due_at: null },
      ],
    })]);

    const queue = await ops.getQueue({ orgId: ORG, today: TODAY, now: NOW });

    expect(queue.counts.total).toBe(1);
    expect(queue.counts.by_family.churn).toBe(1);
    expect(queue.counts.by_family.training).toBe(1);
  });

  it('computes channel once per org and prefers opt-out over connection', async () => {
    transport.resolveInstance.mockResolvedValue({ ok: false, reason: 'not_connected' });
    repo.findOpenItems.mockResolvedValue([
      openRow({ id: 'a', whatsapp_opt_out: true }),
      openRow({ id: 'b', mobile: null }),
      openRow({ id: 'c' }),
      openRow({ id: 'd', recommended_action: { kind: 'internal', label: 'Open screening', href: '/pt-os/clients/c1', reason_code: 'parq_missing' } }),
    ]);

    const queue = await ops.getQueue({ orgId: ORG, today: TODAY, now: NOW });
    const byId = Object.fromEntries(queue.items.map((i) => [i.id, i.channel]));

    expect(byId.a).toEqual({ status: 'unavailable', reason: 'opted_out' });
    expect(byId.b).toEqual({ status: 'unavailable', reason: 'no_recipient' });
    expect(byId.c).toEqual({ status: 'unavailable', reason: 'not_connected' });
    expect(byId.d).toEqual({ status: 'connected', reason: null });
    expect(transport.resolveInstance).toHaveBeenCalledTimes(1);
  });

  it('fills a template draft for a message item without one', async () => {
    repo.findOpenItems.mockResolvedValue([openRow()]);

    const queue = await ops.getQueue({ orgId: ORG, today: TODAY, now: NOW });

    expect(templateDraft).toHaveBeenCalledWith(expect.objectContaining({ studioName: 'Iron House' }));
    expect(queue.items[0].draft.source).toBe('template');
    expect(repo.updateItem).toHaveBeenCalledWith(ORG, 'i1', 'open', { draft: expect.any(Object) });
    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it('regenerates a draft whose reason key no longer matches', async () => {
    repo.findOpenItems.mockResolvedValue([openRow({
      draft: {
        body: 'stale', channel: 'whatsapp', source: 'ai', model: 'm',
        generated_at: NOW.toISOString(), confidence: 0.8, reason_key: 'dues:oldhash',
      },
    })]);

    await ops.getQueue({ orgId: ORG, today: TODAY, now: NOW });

    expect(templateDraft).toHaveBeenCalled();
  });

  it('keeps an AI draft whose reason key matches', async () => {
    repo.findOpenItems.mockResolvedValue([openRow({
      draft: {
        body: 'Hi Ravi, could you clear the pending balance?', channel: 'whatsapp',
        source: 'ai', model: 'm', generated_at: NOW.toISOString(),
        confidence: 0.9, reason_key: reasonIdentity(dues),
      },
    })]);

    const queue = await ops.getQueue({ orgId: ORG, today: TODAY, now: NOW });

    expect(templateDraft).not.toHaveBeenCalled();
    expect(queue.items[0].draft.body).toContain('clear the pending balance');
  });

  it('returns the stored brief when one exists today', async () => {
    repo.latestBrief.mockResolvedValue({
      payload: { text: 'Two renewals need you today.', source: 'ai', generated_at: '2026-11-25T08:00:00.000Z' },
      created_at: '2026-11-25T08:00:00.000Z',
    });

    const queue = await ops.getQueue({ orgId: ORG, today: TODAY, now: NOW });

    expect(queue.brief).toEqual({
      text: 'Two renewals need you today.', source: 'ai', generated_at: '2026-11-25T08:00:00.000Z',
    });
    expect(queue.ai.status).toBe('ok');
  });
});

describe('item actions', () => {
  it('404s a foreign item without writing', async () => {
    repo.findItem.mockResolvedValue(null);

    await expect(ops.getItem({ orgId: ORG, itemId: 'x' })).rejects.toMatchObject({
      name: 'OpsError', status: 404, code: 'NOT_FOUND',
    });
  });

  it('snoozes an open item for an allowed number of days', async () => {
    repo.findItem
      .mockResolvedValueOnce(openRow())
      .mockResolvedValueOnce(openRow({ status: 'snoozed' }));

    await ops.snooze({ orgId: ORG, itemId: 'i1', days: 3, actor: { userId: 'u1', role: 'trainer' } });

    expect(repo.updateItem).toHaveBeenCalledWith(ORG, 'i1', 'open', expect.objectContaining({
      status: 'snoozed', snoozed_until: expect.any(Date),
    }));
    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      eventType: 'snoozed', payload: { days: 3 },
    }));
  });

  it('rejects an unsupported snooze length', async () => {
    repo.findItem.mockResolvedValue(openRow());

    await expect(ops.snooze({
      orgId: ORG, itemId: 'i1', days: 2, actor: { userId: 'u1', role: 'trainer' },
    })).rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
  });

  it('dismisses with a stored reason and the closed evidence', async () => {
    repo.findItem
      .mockResolvedValueOnce(openRow())
      .mockResolvedValueOnce(openRow({ status: 'dismissed' }));

    await ops.dismiss({
      orgId: ORG, itemId: 'i1', reason: 'not_relevant', actor: { userId: 'u1', role: 'trainer' },
    });

    expect(repo.updateItem).toHaveBeenCalledWith(ORG, 'i1', 'open', expect.objectContaining({
      status: 'dismissed', dismissed_reason: 'not_relevant', closed_score: 15,
    }));
    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      eventType: 'dismissed', payload: { reason: 'not_relevant' },
    }));
  });

  it('rejects an unknown dismiss reason', async () => {
    repo.findItem.mockResolvedValue(openRow());

    await expect(ops.dismiss({
      orgId: ORG, itemId: 'i1', reason: 'whatever', actor: { userId: 'u1', role: 'trainer' },
    })).rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
  });

  it('resolves manually with a manual audit flag', async () => {
    repo.findItem
      .mockResolvedValueOnce(openRow())
      .mockResolvedValueOnce(openRow({ status: 'resolved' }));

    await ops.resolveManually({ orgId: ORG, itemId: 'i1', actor: { userId: 'u1', role: 'trainer' } });

    expect(repo.updateItem).toHaveBeenCalledWith(ORG, 'i1', 'open', expect.objectContaining({ status: 'resolved' }));
    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      eventType: 'resolved', payload: { manual: true },
    }));
  });

  it('rejects an action on a closed item', async () => {
    repo.findItem.mockResolvedValue(openRow({ status: 'dismissed' }));

    await expect(ops.resolveManually({
      orgId: ORG, itemId: 'i1', actor: { userId: 'u1', role: 'trainer' },
    })).rejects.toMatchObject({ status: 409, code: 'NOT_APPROVABLE' });
  });
});
