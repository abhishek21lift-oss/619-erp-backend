'use strict';

// The HTTP surface. Access control is decided at the mount (studioGate), and
// this test mounts the real requireTrainer so a member is refused before the
// service runs. Error mapping is explicit: an OpsError keeps its status/code,
// anything else is not leaked.

jest.mock('../modules/ai-ops/ops.service', () => ({
  getQueue: jest.fn(),
  refresh: jest.fn(),
  getItem: jest.fn(),
  approve: jest.fn(),
  snooze: jest.fn(),
  dismiss: jest.fn(),
  resolveManually: jest.fn(),
}));
jest.mock('../middleware/aiRateLimit', () => ({ aiLimiter: (req, res, next) => next() }));
jest.mock('../lib/aiQuota', () => ({ requireAiQuota: () => (req, res, next) => next() }));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const ops = require('../modules/ai-ops/ops.service');
const { requireTrainer } = require('../middleware/rbac');
const router = require('../modules/ai-ops/ops.routes');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, res, next) => {
    req.user = {
      id: 'u1',
      role: req.headers['x-role'] || 'trainer',
      organization_id: 'org-1',
    };
    req.id = 'req-1';
    next();
  });
  instance.use(requireTrainer);
  instance.use('/api/ai/ops', router);
  instance.use((err, req, res, next) => {
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });
  return instance;
}

function opsError(status, code, message) {
  return Object.assign(new Error(message), { name: 'OpsError', status, code });
}

beforeEach(() => {
  jest.clearAllMocks();
  ops.getQueue.mockResolvedValue({ items: [], counts: { total: 0 } });
  ops.refresh.mockResolvedValue({ items: [], ai: { status: 'ok' } });
  ops.getItem.mockResolvedValue({ item: { id: 'i1' }, events: [] });
  ops.approve.mockResolvedValue({ item: { id: 'i1' }, delivery: { status: 'sent' } });
  ops.snooze.mockResolvedValue({ id: 'i1' });
  ops.dismiss.mockResolvedValue({ id: 'i1' });
  ops.resolveManually.mockResolvedValue({ id: 'i1' });
});

describe('read routes', () => {
  it('returns the queue', async () => {
    const res = await request(app()).get('/api/ai/ops/queue');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { items: [], counts: { total: 0 } } });
    expect(ops.getQueue).toHaveBeenCalledWith({ orgId: 'org-1', today: expect.any(String) });
  });

  it('returns one item with its events', async () => {
    const res = await request(app()).get('/api/ai/ops/items/i1');

    expect(res.status).toBe(200);
    expect(res.body.data.item.id).toBe('i1');
    expect(ops.getItem).toHaveBeenCalledWith({ orgId: 'org-1', itemId: 'i1' });
  });

  it('refuses a member before the service runs', async () => {
    const res = await request(app()).get('/api/ai/ops/queue').set('x-role', 'member');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(ops.getQueue).not.toHaveBeenCalled();
  });
});

describe('refresh', () => {
  it('passes the actor and request id to the service', async () => {
    const res = await request(app()).post('/api/ai/ops/refresh').send({});

    expect(res.status).toBe(200);
    expect(ops.refresh).toHaveBeenCalledWith({
      orgId: 'org-1',
      today: expect.any(String),
      actor: { userId: 'u1', role: 'trainer' },
      requestId: 'req-1',
    });
  });
});

describe('approve', () => {
  it('accepts no body and a string body', async () => {
    let res = await request(app()).post('/api/ai/ops/items/i1/approve').send({});
    expect(res.status).toBe(200);
    expect(ops.approve).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'i1', body: undefined }));

    res = await request(app()).post('/api/ai/ops/items/i1/approve').send({ body: 'Hi Ravi' });
    expect(res.status).toBe(200);
    expect(ops.approve).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'Hi Ravi' }));
  });

  it('rejects a non-string body', async () => {
    const res = await request(app()).post('/api/ai/ops/items/i1/approve').send({ body: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(ops.approve).not.toHaveBeenCalled();
  });

  it('rejects a body over 1200 characters', async () => {
    const res = await request(app()).post('/api/ai/ops/items/i1/approve').send({ body: 'a'.repeat(1201) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(ops.approve).not.toHaveBeenCalled();
  });
});

describe('snooze, dismiss, resolve', () => {
  it('accepts 1, 3 and 7 days and rejects anything else', async () => {
    for (const days of [1, 3, 7]) {
      const res = await request(app()).post('/api/ai/ops/items/i1/snooze').send({ days });
      expect(res.status).toBe(200);
      expect(ops.snooze).toHaveBeenCalledWith(expect.objectContaining({ days }));
    }

    const bad = await request(app()).post('/api/ai/ops/items/i1/snooze').send({ days: 2 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION');
  });

  it('accepts the four dismiss reasons and rejects others', async () => {
    for (const reason of ['not_relevant', 'already_handled', 'asked_not_to_contact', 'other']) {
      const res = await request(app()).post('/api/ai/ops/items/i1/dismiss').send({ reason });
      expect(res.status).toBe(200);
      expect(ops.dismiss).toHaveBeenCalledWith(expect.objectContaining({ reason }));
    }

    const bad = await request(app()).post('/api/ai/ops/items/i1/dismiss').send({ reason: 'bored' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION');
  });

  it('resolves an item', async () => {
    const res = await request(app()).post('/api/ai/ops/items/i1/resolve').send({});
    expect(res.status).toBe(200);
    expect(ops.resolveManually).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'i1' }));
  });
});

describe('errors', () => {
  it('maps an OpsError to its status and code', async () => {
    ops.approve.mockRejectedValue(opsError(409, 'ALREADY_ACTIONED', 'This item was already actioned'));

    const res = await request(app()).post('/api/ai/ops/items/i1/approve').send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'ALREADY_ACTIONED', message: 'This item was already actioned' });
  });

  it('does not leak an unexpected error', async () => {
    ops.getQueue.mockRejectedValue(new Error('database password is hunter2'));

    const res = await request(app()).get('/api/ai/ops/queue');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});

describe('mounting', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('mounts the ops router behind the AI suite gate before the generic /api/ai mount', () => {
    const opsIndex = serverSrc.indexOf("app.use('/api/ai/ops'");
    const genericIndex = serverSrc.indexOf("app.use('/api/ai',");

    expect(opsIndex).toBeGreaterThan(-1);
    expect(genericIndex).toBeGreaterThan(-1);
    expect(opsIndex).toBeLessThan(genericIndex);
    expect(serverSrc).toMatch(
      /app\.use\('\/api\/ai\/ops',\s+userApiLimiter,\s+\.\.\.studioGate\('ai_suite'\),\s+require\('\.\/modules\/ai-ops\/ops\.routes'\)\)/,
    );
  });

  it('puts the quota guard on refresh only', () => {
    const routerSrc = fs.readFileSync(path.join(__dirname, '..', 'modules', 'ai-ops', 'ops.routes.js'), 'utf8');
    expect(routerSrc).toMatch(/router\.post\('\/refresh',\s+aiLimiter,\s+requireAiQuota\(\)/);
    expect(routerSrc).not.toMatch(/router\.get\('\/queue',\s+aiLimiter/);
  });
});
