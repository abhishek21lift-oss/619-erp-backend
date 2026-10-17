'use strict';
// The Hostinger assistant, and the two things it must never do: run something,
// or leak a credential. Both claims are about the wiring, so both are tested as
// wiring — `plan`/`execute` are spied on and must stay uncalled, and the prompt
// that actually reaches the model is the thing that gets searched for the
// token, not the variable the code intended to keep out of it.

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

jest.mock('../modules/platform/hostinger/credentials.service', () => {
  const actual = jest.requireActual('../modules/platform/hostinger/credentials.service');
  return { ...actual, status: jest.fn(), activeToken: jest.fn() };
});

jest.mock('../modules/platform/hostinger/operations.service', () => {
  const actual = jest.requireActual('../modules/platform/hostinger/operations.service');
  return { ...actual, dashboard: jest.fn(), plan: jest.fn(), execute: jest.fn() };
});

jest.mock('../lib/ai/router', () => ({ routedChat: jest.fn() }));

const router = require('../lib/ai/router');
const credentials = require('../modules/platform/hostinger/credentials.service');
const operations = require('../modules/platform/hostinger/operations.service');
const assistant = require('../modules/platform/hostinger/assistant.service');

const TOKEN = 'hs7Kd2mQ4pRtV9wXzB1cLfN6yEjU3aGq8WvT5bN2sRk';
const ACTOR = 'usr-superadmin-001';

/** The messages array handed to the model on the most recent ask. */
function sentPrompt() {
  const { messages } = router.routedChat.mock.calls.at(-1)[0];
  return messages.map((m) => m.content).join('\n');
}

function modelSays(payload, over = {}) {
  router.routedChat.mockResolvedValue({
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
    model: 'test-model',
    usage: { total_tokens: 10 },
    used_fallback: false,
    ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  assistant._internal.reset();
  credentials.activeToken.mockResolvedValue({ token: TOKEN, credentialId: 'cred-1' });
  credentials.status.mockResolvedValue({ state: 'connected', credential: { hint: '…3aG' } });
  operations.dashboard.mockResolvedValue({
    websites: { ok: true, data: [{ domain: 'shop.example.com', username: 'u123456789', filesystem_root: '/home/u123456789' }] },
    domains: { ok: false, error: { code: 'HOSTINGER_DOMAIN_ERROR', message: 'Domains unavailable' } },
    vps: { ok: true, data: [{ id: 7, hostname: 'vps-1', state: 'running', ipv4: [{ address: '10.0.0.1' }] }] },
    sampled: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  });
  modelSays({ answer: 'All four websites are up.', propose: null });
});

describe('the prompt', () => {
  it('never carries the token', async () => {
    await assistant.ask({ question: 'how many websites?', actorId: ACTOR });
    expect(sentPrompt()).not.toContain(TOKEN);
    expect(sentPrompt()).toContain('shop.example.com');
  });

  it('masks the token when the operator pastes it into the question', async () => {
    await assistant.ask({ question: `is this right? ${TOKEN}`, actorId: ACTOR });
    const prompt = sentPrompt();
    expect(prompt).not.toContain(TOKEN);
    expect(prompt).toContain('[REDACTED]');
  });

  it('still masks a pasted token when the console is not connected', async () => {
    credentials.activeToken.mockRejectedValue(new Error('not connected'));
    await assistant.ask({ question: `here is my key ${TOKEN}`, actorId: ACTOR });
    expect(sentPrompt()).not.toContain(TOKEN);
  });

  it('leaves a pasted build id and a file path readable', async () => {
    const uuid = '3f0c1e88-9b7a-4c2d-8e51-2b6a7c4d9f10';
    await assistant.ask({
      question: `why did build ${uuid} fail? log at /home/u123456789/domains/x.com/public_html/build.log`,
      actorId: ACTOR,
    });
    const prompt = sentPrompt();
    expect(prompt).toContain(uuid);
    expect(prompt).toContain('/home/u123456789/domains/x.com/public_html/build.log');
  });

  it('keeps filesystem paths out of the model context', async () => {
    await assistant.ask({ question: 'any problems?', actorId: ACTOR });
    const prompt = sentPrompt();
    expect(prompt).toContain('shop.example.com');
    expect(prompt).not.toContain('/home/u123456789');
  });

  it('reports which part of the estate could not be read', async () => {
    const result = await assistant.ask({ question: 'any problems?', actorId: ACTOR });
    expect(result.context_errors).toBe(1);
    expect(sentPrompt()).toContain('Domains unavailable');
  });

  it('answers about a broken dashboard instead of failing', async () => {
    operations.dashboard.mockRejectedValue(new Error('dashboard exploded'));
    const result = await assistant.ask({ question: 'is the estate ok?', actorId: ACTOR });
    expect(result.answer).toBeTruthy();
    expect(sentPrompt()).toContain('unavailable');
  });

  it('masks the token if a model echoes it back', async () => {
    modelSays({ answer: `Your token is ${TOKEN} and it works.`, propose: null });
    const result = await assistant.ask({ question: 'check my token', actorId: ACTOR });
    expect(result.answer).not.toContain(TOKEN);
  });

  it('masks the token in an upstream error', async () => {
    router.routedChat.mockRejectedValue(new Error(`provider rejected token ${TOKEN}`));
    const err = await assistant.ask({ question: 'hello', actorId: ACTOR }).catch((e) => e);

    expect(err).toMatchObject({ status: 503, code: 'HOSTINGER_ASSISTANT_UNAVAILABLE' });
    expect(err.message).not.toContain(TOKEN);
  });

  it('refuses an empty question without calling a model', async () => {
    await expect(assistant.ask({ question: '   ', actorId: ACTOR }))
      .rejects.toMatchObject({ status: 400, code: 'HOSTINGER_ASSISTANT_EMPTY' });
    expect(router.routedChat).not.toHaveBeenCalled();
  });
});

describe('it proposes, it does not run', () => {
  it('never reaches the plan or execute path', async () => {
    modelSays({
      answer: 'I propose restarting the machine.',
      propose: { operation: 'vps.restart', params: { path: { virtualMachineId: 7 } } },
    });
    await assistant.ask({ question: 'restart the vps', actorId: ACTOR });

    expect(operations.plan).not.toHaveBeenCalled();
    expect(operations.execute).not.toHaveBeenCalled();
  });

  it('returns a proposal for a write as requiring approval', async () => {
    modelSays({
      answer: 'I propose restarting the machine.',
      propose: { operation: 'vps.restart', params: { path: { virtualMachineId: 7 } } },
    });
    const { proposal } = await assistant.ask({ question: 'restart the vps', actorId: ACTOR });

    expect(proposal).toMatchObject({ operation: 'vps.restart', safety: 'mutate', requires_approval: true });
    expect(proposal.note).toMatch(/approving/i);
  });

  it('marks a read as needing no approval', async () => {
    modelSays({
      answer: 'Checking.',
      propose: { operation: 'hosting.website.list', params: {} },
    });
    const { proposal } = await assistant.ask({ question: 'list my sites', actorId: ACTOR });
    expect(proposal).toMatchObject({ requires_approval: false });
  });
});

describe('proposal validation', () => {
  it('rejects an operation that does not exist', () => {
    const out = assistant.validateProposal({ operation: 'vps.format.everything', params: {} });
    expect(out.rejected).toBe(true);
    expect(out.reason).toMatch(/does not exist/);
  });

  it('rejects a proposal whose parameters do not validate', () => {
    const out = assistant.validateProposal({ operation: 'vps.restart', params: { path: { virtualMachineId: 'seven' } } });
    expect(out.rejected).toBe(true);
    expect(JSON.stringify(out)).toContain('virtualMachineId');
  });

  it('rejects a body key the operation does not have', () => {
    const out = assistant.validateProposal({ operation: 'hosting.website.list', params: { body: { nope: 1 } } });
    expect(out.rejected).toBe(true);
    expect(out.reason).toMatch(/takes no request body/);
  });

  it('rejects query parameters for an operation that takes none', () => {
    const out = assistant.validateProposal({ operation: 'vps.list', params: { query: { per_page: 10 } } });
    expect(out.rejected).toBe(true);
    expect(out.reason).toMatch(/takes no query parameters/);
  });

  it('never lets a model carry a write-only credential into a proposal', () => {
    const out = assistant.validateProposal({
      operation: 'vps.recovery',
      params: { path: { virtualMachineId: 7 }, body: { root_password: 'correct-horse-battery' } },
    });

    expect(out.rejected).toBe(true); // the field is required and was dropped
    expect(JSON.stringify(out)).not.toContain('correct-horse-battery');
    expect(out.fields).toHaveProperty('root_password');
  });

  it('drops a secret from an otherwise valid proposal and says so', () => {
    const out = assistant.validateProposal({
      operation: 'vps.recreate',
      params: { path: { virtualMachineId: 7 }, body: { template_id: 3, password: 'hunter2hunter2' } },
    });

    expect(out.rejected).toBeUndefined();
    expect(out.secret_fields).toEqual(['password']);
    expect(out.safety).toBe('destructive');
    expect(JSON.stringify(out)).not.toContain('hunter2hunter2');
    expect(out.note).toMatch(/never sent to the assistant/);
  });

  it('returns nothing for a model that proposed nothing', () => {
    expect(assistant.validateProposal(null)).toBeNull();
    expect(assistant.validateProposal(undefined)).toBeNull();
    expect(assistant.validateProposal('restart everything')).toBeNull();
  });
});

describe('the per-operator cap', () => {
  it('stops a stuck console after the hourly allowance', async () => {
    for (let i = 0; i < assistant.MAX_ASKS_PER_HOUR; i += 1) {
      await assistant.ask({ question: 'status?', actorId: ACTOR });
    }
    expect(assistant.rateStatus(ACTOR).used).toBe(assistant.MAX_ASKS_PER_HOUR);

    await expect(assistant.ask({ question: 'status?', actorId: ACTOR }))
      .rejects.toMatchObject({ status: 429, code: 'HOSTINGER_ASSISTANT_RATE_LIMITED' });
    expect(router.routedChat).toHaveBeenCalledTimes(assistant.MAX_ASKS_PER_HOUR);
  });

  it('counts each operator separately', async () => {
    await assistant.ask({ question: 'status?', actorId: ACTOR });
    expect(assistant.rateStatus('usr-other').used).toBe(0);
  });
});
