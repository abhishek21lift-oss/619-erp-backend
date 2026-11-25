'use strict';
// The member AI HTTP surface: refusals happen before the stream, and the SSE
// contract carries the answer plus a draft the member must confirm.
jest.mock('../modules/member-ai/member-ai.service', () => ({
  ask: jest.fn(), historyFor: jest.fn(), clearHistory: jest.fn(),
}));
jest.mock('../lib/ai/config', () => ({
  isConfigured: jest.fn(() => true),
  configurationProblem: jest.fn(() => 'AI is not configured.'),
}));
jest.mock('../lib/sse-heartbeat', () => ({ startSseHeartbeat: jest.fn(() => jest.fn()) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const request = require('supertest');
const express = require('express');
const { ask, historyFor, clearHistory } = require('../modules/member-ai/member-ai.service');
const { isConfigured } = require('../lib/ai/config');
const router = require('../modules/member-ai/member-ai.routes');

const ORG = '11111111-1111-4111-8111-111111111111';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (req.headers.authorization === 'Bearer member') {
    req.user = { id: 'u1', role: 'member', organization_id: ORG, pt_client_id: 'c1' };
    req.id = 'req-1';
  }
  if (req.headers.authorization === 'Bearer trainer') {
    req.user = { id: 'u2', role: 'trainer', organization_id: ORG };
  }
  next();
});
app.use('/api/me/ai', router);

function events(res) {
  return String(res.text || '').split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

beforeEach(() => {
  jest.clearAllMocks();
  isConfigured.mockReturnValue(true);
  historyFor.mockResolvedValue([]);
});

describe('refusals before the stream', () => {
  it('returns 401 without a user', async () => {
    const res = await request(app).post('/api/me/ai/chat').send({ message: 'hi' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTH');
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([[''], ['   '], ['x'.repeat(2001)]])('rejects message %p with 400', async (message) => {
    const res = await request(app).post('/api/me/ai/chat')
      .set('Authorization', 'Bearer member').send({ message });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(ask).not.toHaveBeenCalled();
  });

  it('returns 501 when the provider is not configured', async () => {
    isConfigured.mockReturnValue(false);
    const res = await request(app).post('/api/me/ai/chat')
      .set('Authorization', 'Bearer member').send({ message: 'hi' });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('AI_NOT_CONFIGURED');
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses a non-member session in the router itself', async () => {
    const res = await request(app).post('/api/me/ai/chat')
      .set('Authorization', 'Bearer trainer').send({ message: 'hi' });
    expect(res.status).toBe(403);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('SSE contract', () => {
  it('streams start, deltas and done with the draft proposal', async () => {
    ask.mockImplementation(async ({ onDelta }) => {
      onDelta('Hello', { toolsUsed: ['getMyWorkout'], toolsUnavailable: [] });
      onDelta('Hello world', { toolsUsed: ['getMyWorkout'], toolsUnavailable: [] });
      return {
        ok: true,
        message: 'Hello world',
        toolsUsed: ['getMyWorkout'],
        toolsUnavailable: [],
        proposedMessage: 'Hi',
        requiresConfirmation: true,
        meta: {},
      };
    });

    const res = await request(app).post('/api/me/ai/chat')
      .set('Authorization', 'Bearer member').send({ message: 'hi' });

    const list = events(res);
    expect(list.map((e) => e.type)).toEqual(['start', 'chunk', 'chunk', 'done']);
    expect(list[1].content).toBe('Hello');
    expect(list[2].content).toBe(' world');
    expect(list[3].proposedMessage).toBe('Hi');
    expect(list[3].requiresConfirmation).toBe(true);
  });

  it('sends one terminal error event and no done', async () => {
    ask.mockResolvedValue({ ok: false, code: 'AI_FAILED', status: 502, message: 'Unavailable.' });

    const res = await request(app).post('/api/me/ai/chat')
      .set('Authorization', 'Bearer member').send({ message: 'hi' });

    const list = events(res);
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('error');
    expect(list[0].code).toBe('AI_FAILED');
    expect(list.some((e) => e.type === 'done')).toBe(false);
  });

  it('sends nothing after a member disconnect', async () => {
    ask.mockResolvedValue({ ok: false, status: 499, code: 'MEMBER_AI_DISCONNECTED' });

    const res = await request(app).post('/api/me/ai/chat')
      .set('Authorization', 'Bearer member').send({ message: 'hi' });

    expect(events(res)).toHaveLength(0);
  });
});

describe('history', () => {
  it('returns the member turns and whether AI is configured', async () => {
    historyFor.mockResolvedValue([
      { role: 'assistant', content: 'Welcome back', created_at: '2026-11-25T10:00:00Z' },
    ]);

    const res = await request(app).get('/api/me/ai/history')
      .set('Authorization', 'Bearer member');

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(1);
    expect(res.body.data.configured).toBe(true);
    expect(historyFor).toHaveBeenCalledWith(ORG, 'u1', 40);
  });

  it('clears the member thread', async () => {
    clearHistory.mockResolvedValue(2);

    const res = await request(app).delete('/api/me/ai/history')
      .set('Authorization', 'Bearer member');

    expect(res.status).toBe(200);
    expect(res.body.data.cleared).toBe(true);
    expect(clearHistory).toHaveBeenCalledWith(ORG, 'u1');
  });
});

describe('mount', () => {
  it('mounts behind the member, feature, rate and quota guards', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../server.js'), 'utf8',
    );
    const start = src.indexOf("app.use('/api/me/ai'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 400);
    expect(block).toContain('auth');
    expect(block).toContain('requireClient');
    expect(block).toContain("requireFeature('ai_suite')");
    expect(block).toContain('userApiLimiter');
    expect(block).toContain('aiLimiter');
    expect(block).toContain('requireAiQuota()');
  });
});
