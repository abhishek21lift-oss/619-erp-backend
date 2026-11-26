'use strict';

// AI drafting is one batched call per refresh, fenced, metered, and optional.
// The queue is fully usable without it: a failed model call returns ok:false
// and the caller keeps the deterministic templates.

jest.mock('../lib/ai/router', () => ({ routedChat: jest.fn() }));
jest.mock('../lib/ai/usage', () => ({ logUsage: jest.fn() }));
jest.mock('../lib/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { routedChat } = require('../lib/ai/router');
const { logUsage } = require('../lib/ai/usage');
const { buildOpsQueueSystemPrompt } = require('../lib/ai/prompts/system');
const { INTENT_ROUTES } = require('../lib/ai/models');
const { generateDrafts } = require('../modules/ai-ops/draft');

const ORG = 'org-1';
const ACTOR = { userId: 'u1', role: 'trainer' };
const REQUEST = 'req-1';

function item(over = {}) {
  return {
    id: 'i1',
    subject: { type: 'client', id: 'c1', name: 'Ravi Kumar', photo_url: null },
    status: 'open',
    priority_score: 15,
    priority_band: 'medium',
    reasons: [{
      code: 'dues', label: '₹4,500 overdue', points: 15, family: 'churn',
      evidence: { balance_amount: 4500 }, due_at: null,
    }],
    recommended_action: { kind: 'message', label: 'Send payment reminder', href: null, reason_code: 'dues' },
    channel: { status: 'connected', reason: null },
    ...over,
  };
}

function reply(over = {}) {
  return {
    content: JSON.stringify({
      brief: 'Two clients need a nudge today.',
      items: [{ id: 'i1', message: 'Hi Ravi, could you clear the pending balance?', rationale: 'Dues', confidence: 0.8 }],
      ...over,
    }),
    model: 'test/model',
    usage: { prompt_tokens: 120, completion_tokens: 40, cost: 0.0002 },
    latency_ms: 900,
    used_fallback: false,
    routed_via: 'openrouter',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  routedChat.mockResolvedValue(reply());
  logUsage.mockResolvedValue({ inserted: true });
});

describe('buildOpsQueueSystemPrompt', () => {
  it('is instructions only, with no data from a client', () => {
    const prompt = buildOpsQueueSystemPrompt();

    expect(prompt).toContain('JSON');
    expect(prompt).toContain('English');
    expect(prompt).toContain('untrusted-data');
    expect(prompt).toContain('Never invent');
    expect(prompt).not.toContain('Ravi');
    expect(prompt).not.toContain('+9190');
    expect(prompt).not.toMatch(/\bi1\b/);
  });
});

describe('generateDrafts', () => {
  it('makes exactly one routed call for the queue intent', async () => {
    await generateDrafts({ orgId: ORG, items: [item()], studioName: 'Iron House', actor: ACTOR, requestId: REQUEST });

    expect(routedChat).toHaveBeenCalledTimes(1);
    expect(routedChat).toHaveBeenCalledWith(expect.objectContaining({ intent: 'ops_queue' }));
  });

  it('routes ops_queue to the primary tier without disturbing the ops intent', () => {
    expect(INTENT_ROUTES.ops_queue).toBe('primary');
    expect(INTENT_ROUTES.ops).toBeDefined();
  });

  it('fences the payload and never sends a phone number', async () => {
    await generateDrafts({ orgId: ORG, items: [item()], studioName: 'Iron House', actor: ACTOR, requestId: REQUEST });

    const messages = routedChat.mock.calls[0][0].messages;
    const user = messages.find((m) => m.role === 'user').content;
    expect(user).toContain('<untrusted-data');
    expect(user).toContain('</untrusted-data');
    expect(user).not.toContain('+919000000001');
  });

  it('includes only connected message items, highest priority first, capped at twelve', async () => {
    const items = Array.from({ length: 14 }, (_, index) => item({
      id: `i${index + 1}`,
      priority_score: 100 - index,
    }));
    items.push(item({ id: 'internal', recommended_action: { kind: 'internal', label: 'Review', href: '/x', reason_code: 'parq_missing' } }));
    items.push(item({ id: 'offline', channel: { status: 'unavailable', reason: 'not_connected' } }));

    await generateDrafts({ orgId: ORG, items, studioName: 'Iron House', actor: ACTOR, requestId: REQUEST });

    const user = routedChat.mock.calls[0][0].messages.find((m) => m.role === 'user').content;
    const body = user.match(/<untrusted-data[^>]*>\n([\s\S]*?)\n<\/untrusted-data[^>]*>/)[1];
    const payload = JSON.parse(body);

    expect(payload.items).toHaveLength(12);
    expect(payload.items[0].id).toBe('i1');
    expect(payload.items.map((i) => i.id)).not.toContain('internal');
    expect(payload.items.map((i) => i.id)).not.toContain('offline');
    expect(payload.studio_name).toBe('Iron House');
  });

  it('accepts a valid response, clamps confidence and ignores unknown ids', async () => {
    routedChat.mockResolvedValue(reply({
      items: [
        { id: 'i1', message: '  Hi Ravi, could you clear the pending balance?  ', rationale: 'Dues', confidence: 1.5 },
        { id: 'ghost', message: 'hello', confidence: 0.5 },
      ],
    }));

    const result = await generateDrafts({
      orgId: ORG, items: [item()], studioName: 'Iron House', actor: ACTOR, requestId: REQUEST,
    });

    expect(result.ok).toBe(true);
    expect(result.brief).toBe('Two clients need a nudge today.');
    expect(result.drafts.get('i1').body).toBe('Hi Ravi, could you clear the pending balance?');
    expect(result.drafts.get('i1').confidence).toBe(1);
    expect(result.drafts.has('ghost')).toBe(false);
    expect(result.rejected).toContain('ghost');
  });

  it('meters the call once, with the queue intent and the org', async () => {
    await generateDrafts({ orgId: ORG, items: [item()], studioName: 'Iron House', actor: ACTOR, requestId: REQUEST });

    expect(logUsage).toHaveBeenCalledTimes(1);
    expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'u1',
      organization_id: ORG,
      model: 'test/model',
      intent_type: 'ai_ops_queue',
      request_id: REQUEST,
      used_fallback: false,
      tokens_prompt: 120,
      tokens_completion: 40,
    }));
  });

  it('estimates usage instead of recording zeros when the provider omits it', async () => {
    const noUsage = reply();
    delete noUsage.usage;
    routedChat.mockResolvedValue(noUsage);

    await generateDrafts({ orgId: ORG, items: [item()], studioName: 'Iron House', actor: ACTOR, requestId: REQUEST });

    const logged = logUsage.mock.calls[0][0];
    expect(logged.tokens_completion).toBeGreaterThan(0);
    expect(logged.usage_source).toBe('estimated');
  });

  it('fails soft on invalid JSON, a missing items array or a thrown provider', async () => {
    const cases = [
      { ...reply(), content: 'not json' },
      { ...reply(), content: JSON.stringify({ brief: 'x' }) },
      { ...reply(), content: JSON.stringify({ brief: 'x', items: [{ id: 'i1', message: '' }] }) },
      { ...reply(), content: JSON.stringify({ brief: 'x', items: [{ id: 'i1', message: 'a'.repeat(1201) }] }) },
    ];

    for (const response of cases) {
      routedChat.mockResolvedValueOnce(response);
      const result = await generateDrafts({
        orgId: ORG, items: [item()], studioName: 'Iron House', actor: ACTOR, requestId: REQUEST,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    }

    routedChat.mockRejectedValueOnce(new Error('provider down'));
    const failed = await generateDrafts({
      orgId: ORG, items: [item()], studioName: 'Iron House', actor: ACTOR, requestId: REQUEST,
    });
    expect(failed.ok).toBe(false);
    expect(failed.message).toBe('AI drafts are unavailable right now.');
  });

  it('does not call the model with no eligible items', async () => {
    const result = await generateDrafts({
      orgId: ORG,
      items: [item({ channel: { status: 'unavailable', reason: 'no_recipient' } })],
      studioName: 'Iron House', actor: ACTOR, requestId: REQUEST,
    });

    expect(routedChat).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_items');
  });
});
