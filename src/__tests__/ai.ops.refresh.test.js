'use strict';

// Refresh is the only AI-spending path. It is cooldown-limited from the
// database (not an in-process map, so two instances agree), it never fails the
// queue when the model fails, and it never overwrites an item a trainer
// actioned while the model was thinking.

jest.mock('../modules/ai-ops/ops.repository');
jest.mock('../modules/ai-ops/signals', () => ({ collectAll: jest.fn() }));
jest.mock('../modules/ai-ops/templates', () => ({ templateDraft: jest.fn() }));
jest.mock('../modules/ai-ops/draft', () => ({ generateDrafts: jest.fn() }));
jest.mock('../modules/messaging/transport', () => ({ resolveInstance: jest.fn() }));

const repo = require('../modules/ai-ops/ops.repository');
const { collectAll } = require('../modules/ai-ops/signals');
const { templateDraft } = require('../modules/ai-ops/templates');
const { generateDrafts } = require('../modules/ai-ops/draft');
const transport = require('../modules/messaging/transport');
const ops = require('../modules/ai-ops/ops.service');
const { reasonIdentity } = require('../modules/ai-ops/priority');

const ORG = 'org-1';
const TODAY = '2026-11-25';
const NOW = new Date('2026-11-25T09:00:00.000Z');
const ACTOR = { userId: 'u1', role: 'trainer' };

const dues = {
  code: 'dues', label: '₹4,500 overdue', points: 15, family: 'churn',
  evidence: { balance_amount: 4500 }, due_at: null,
};

const template = {
  body: 'Hi Ravi, a balance of ₹4,500 is pending.',
  channel: 'whatsapp', source: 'template', model: null,
  generated_at: NOW.toISOString(), confidence: null, reason_key: reasonIdentity(dues),
};

const aiDraft = {
  body: 'Hi Ravi, could you clear the pending balance before your next session?',
  channel: 'whatsapp', source: 'ai', model: 'test/model',
  generated_at: NOW.toISOString(), confidence: 0.9, reason_key: reasonIdentity(dues),
};

function openRow(over = {}) {
  return {
    id: 'i1', client_id: 'c1', lead_id: null, dedupe_key: 'client:c1',
    status: 'open', priority_score: 15, priority_band: 'medium',
    reasons: [dues], next_due_at: null,
    recommended_action: { kind: 'message', label: 'Send payment reminder', href: null, reason_code: 'dues' },
    draft: null, closed_reasons: [], closed_score: 0,
    snoozed_until: null, dismissed_reason: null, last_contacted_at: null,
    last_actioned_at: null, last_error: null, resolved_at: null,
    created_at: '2026-11-20T09:00:00.000Z',
    subject_type: 'client', subject_name: 'Ravi', photo_url: null,
    mobile: '+919000000001', whatsapp_opt_out: false, lead_mobile: null,
    ...over,
  };
}

const briefRow = {
  payload: {
    text: 'Two renewals need you today.',
    source: 'ai',
    generated_at: '2026-11-25T08:00:00.000Z',
  },
  created_at: '2026-11-25T08:00:00.000Z',
};

beforeEach(() => {
  jest.resetAllMocks();
  collectAll.mockResolvedValue([]);
  repo.findItems.mockResolvedValue([]);
  repo.findOpenItems.mockResolvedValue([openRow()]);
  repo.findItem.mockResolvedValue(openRow());
  repo.orgName.mockResolvedValue('Iron House');
  repo.latestBrief.mockResolvedValue(null);
  repo.latestBriefAt.mockResolvedValue(null);
  repo.insertEvent.mockResolvedValue('evt-1');
  repo.updateItem.mockResolvedValue({ id: 'i1' });
  transport.resolveInstance.mockResolvedValue({ ok: true });
  templateDraft.mockReturnValue(template);
  generateDrafts.mockResolvedValue({
    ok: true,
    brief: 'One balance needs a nudge today.',
    drafts: new Map([['i1', aiDraft]]),
    model: 'test/model',
    rejected: [],
  });
});

describe('refresh cooldown', () => {
  it('does not spend again inside five minutes', async () => {
    repo.latestBriefAt.mockResolvedValue('2026-11-25T08:58:00.000Z');
    repo.latestBrief.mockResolvedValue(briefRow);

    const result = await ops.refresh({ orgId: ORG, today: TODAY, actor: ACTOR, requestId: 'r1', now: NOW });

    expect(generateDrafts).not.toHaveBeenCalled();
    expect(result.ai.status).toBe('cooldown');
    expect(result.brief.text).toBe('Two renewals need you today.');
  });

  it('proceeds at exactly five minutes', async () => {
    repo.latestBriefAt.mockResolvedValue('2026-11-25T08:55:00.000Z');

    const result = await ops.refresh({ orgId: ORG, today: TODAY, actor: ACTOR, requestId: 'r1', now: NOW });

    expect(generateDrafts).toHaveBeenCalledTimes(1);
    expect(result.ai.status).toBe('ok');
  });

  it('proceeds when no brief has ever been generated', async () => {
    await ops.refresh({ orgId: ORG, today: TODAY, actor: ACTOR, requestId: 'r1', now: NOW });
    expect(generateDrafts).toHaveBeenCalledTimes(1);
  });

  it('reads the cooldown from the database on every call', async () => {
    await ops.refresh({ orgId: ORG, today: TODAY, actor: ACTOR, requestId: 'r1', now: NOW });
    await ops.refresh({ orgId: ORG, today: TODAY, actor: ACTOR, requestId: 'r2', now: NOW });

    expect(repo.latestBriefAt).toHaveBeenCalledTimes(2);
  });
});

describe('refresh success', () => {
  it('writes one brief event and one draft event per accepted item', async () => {
    const result = await ops.refresh({ orgId: ORG, today: TODAY, actor: ACTOR, requestId: 'r1', now: NOW });

    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      itemId: null,
      eventType: 'brief_generated',
      actorUserId: 'u1',
      actorRole: 'trainer',
      payload: expect.objectContaining({
        date: TODAY, text: 'One balance needs a nudge today.', source: 'ai', model: 'test/model',
      }),
    }));
    expect(repo.updateItem).toHaveBeenCalledWith(ORG, 'i1', 'open', { draft: aiDraft });
    expect(repo.insertEvent).toHaveBeenCalledWith(ORG, expect.objectContaining({
      itemId: 'i1',
      eventType: 'draft_generated',
      payload: expect.objectContaining({
        source: 'ai', model: 'test/model', confidence: 0.9, body_length: aiDraft.body.length,
      }),
    }));
    expect(result.ai.status).toBe('ok');
    expect(result.brief).toEqual(expect.objectContaining({ source: 'ai' }));
  });

  it('passes the actor and request id to the model layer', async () => {
    await ops.refresh({ orgId: ORG, today: TODAY, actor: ACTOR, requestId: 'r1', now: NOW });

    expect(generateDrafts).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, studioName: 'Iron House', actor: ACTOR, requestId: 'r1',
    }));
  });
});

describe('refresh failure', () => {
  it('keeps the template queue and reports a soft failure', async () => {
    generateDrafts.mockResolvedValue({ ok: false, reason: 'model_failed', message: 'AI drafts are unavailable right now.' });

    const result = await ops.refresh({ orgId: ORG, today: TODAY, actor: ACTOR, requestId: 'r1', now: NOW });

    expect(result.ai).toEqual({
      status: 'failed',
      message: 'AI drafts are unavailable right now.',
      last_generated_at: null,
    });
    expect(result.items[0].draft.source).toBe('template');
    expect(repo.insertEvent).not.toHaveBeenCalledWith(ORG, expect.objectContaining({ eventType: 'brief_generated' }));
    expect(repo.insertEvent).not.toHaveBeenCalledWith(ORG, expect.objectContaining({ eventType: 'draft_generated' }));
  });

  it('does not overwrite an item actioned while the model was thinking', async () => {
    repo.updateItem.mockResolvedValue(null);

    await ops.refresh({ orgId: ORG, today: TODAY, actor: ACTOR, requestId: 'r1', now: NOW });

    expect(repo.insertEvent).not.toHaveBeenCalledWith(ORG, expect.objectContaining({ eventType: 'draft_generated' }));
  });
});

describe('refresh with nothing to draft', () => {
  it('does not call the model and keeps an existing brief', async () => {
    repo.findOpenItems.mockResolvedValue([openRow({
      recommended_action: { kind: 'internal', label: 'Open screening', href: '/pt-os/clients/c1', reason_code: 'parq_missing' },
    })]);
    repo.latestBrief.mockResolvedValue(briefRow);

    const result = await ops.refresh({ orgId: ORG, today: TODAY, actor: ACTOR, requestId: 'r1', now: NOW });

    expect(generateDrafts).not.toHaveBeenCalled();
    expect(result.ai.status).toBe('ok');
    expect(result.brief.text).toBe('Two renewals need you today.');
  });

  it('reports not_generated when there is nothing to draft and no brief', async () => {
    repo.findOpenItems.mockResolvedValue([openRow({
      recommended_action: { kind: 'internal', label: 'Open screening', href: '/pt-os/clients/c1', reason_code: 'parq_missing' },
    })]);

    const result = await ops.refresh({ orgId: ORG, today: TODAY, actor: ACTOR, requestId: 'r1', now: NOW });

    expect(generateDrafts).not.toHaveBeenCalled();
    expect(result.ai.status).toBe('not_generated');
    expect(result.brief).toBeNull();
  });
});
