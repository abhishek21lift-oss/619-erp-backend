'use strict';
// The Hostinger routes.
//
// The service layer has its own tests; this file is about what only the HTTP
// layer can get wrong: a route that answers without being audited, an audit row
// that carries the token or a password, an upstream failure that arrives as a
// 200, and the generic `/operations/*` endpoints accepting a request the
// catalogue never named.
//
// The mount guard is not tested here — this router is mounted inside
// /api/super-admin, and platformNamespace.test.js asserts that boundary.

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../lib/rateLimitStore', () => ({ makeStore: () => undefined }));

jest.mock('../modules/platform/super-admin/shared', () => ({
  audit: jest.fn().mockResolvedValue(undefined),
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  pool: { query: jest.fn() },
}));

jest.mock('../modules/platform/hostinger/credentials.service', () => {
  const actual = jest.requireActual('../modules/platform/hostinger/credentials.service');
  return {
    ...actual,
    status: jest.fn(),
    history: jest.fn(),
    connect: jest.fn(),
    rotate: jest.fn(),
    reverify: jest.fn(),
    revoke: jest.fn(),
    activeToken: jest.fn(),
  };
});

jest.mock('../modules/platform/hostinger/operations.service', () => {
  const actual = jest.requireActual('../modules/platform/hostinger/operations.service');
  return {
    ...actual,
    dashboard: jest.fn(),
    vpsDetail: jest.fn(),
    read: jest.fn(),
    plan: jest.fn(),
    execute: jest.fn(),
    pendingApprovals: jest.fn(),
    deny: jest.fn(),
    history: jest.fn(),
    publicParams: jest.fn(() => ({ path: { virtualMachineId: 7 } })),
  };
});

jest.mock('../modules/platform/hostinger/assistant.service', () => ({
  ask: jest.fn(),
  rateStatus: jest.fn(() => ({ used: 1, limit: 60 })),
  maskShapedCredentials: jest.fn((text) => text),
}));

const request = require('supertest');
const express = require('express');
const router = require('../modules/platform/super-admin/hostinger');
const credentials = require('../modules/platform/hostinger/credentials.service');
const operations = require('../modules/platform/hostinger/operations.service');
const assistant = require('../modules/platform/hostinger/assistant.service');
const { audit, logger } = require('../modules/platform/super-admin/shared');

const ACTOR = { id: 'usr-superadmin-001', name: 'Ops Owner', role: 'super_admin' };
const TOKEN = 'hs7Kd2mQ4pRtV9wXzB1cLfN6yEjU3aGq8WvT5bN2sRk';

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = ACTOR; next(); });
app.use(router);

/** The data of the nth audit call (0 = most recent). */
function auditData(n = 0) {
  return audit.mock.calls.at(-(n + 1))[4];
}

beforeEach(() => {
  jest.clearAllMocks();
  assistant.maskShapedCredentials.mockImplementation((text) => text);
  credentials.status.mockResolvedValue({ state: 'connected', key_configured: true, credential: { id: 'cred-1', hint: '…sRk' } });
  credentials.history.mockResolvedValue([{ id: 'cred-1', label: 'ops', token_hint: '…sRk' }]);
  credentials.connect.mockResolvedValue({ state: 'connected', unchanged: false, credential: { id: 'cred-1', label: 'ops', hint: '…sRk' } });
  credentials.rotate.mockResolvedValue({ state: 'connected', unchanged: false, credential: { id: 'cred-2', label: 'ops', hint: '…sRk' } });
  credentials.reverify.mockResolvedValue({ ok: true, status: 200 });
  credentials.revoke.mockResolvedValue({ id: 'cred-1', label: 'ops', token_hint: '…sRk' });
  credentials.activeToken.mockResolvedValue({ token: TOKEN, credentialId: 'cred-1' });
  operations.read.mockResolvedValue({ ok: true, status: 200, data: { items: [{ id: 7 }] } });
  operations.plan.mockResolvedValue({ approval_id: '11111111-1111-4111-8111-111111111111', operation: 'vps.restart', safety: 'mutate' });
  operations.execute.mockResolvedValue({ ok: true, status: 200, approval_id: '11111111-1111-4111-8111-111111111111', operation: 'vps.restart', safety: 'mutate', data: { scheduled: true } });
  operations.pendingApprovals.mockResolvedValue([]);
  operations.history.mockResolvedValue({ rows: [], total: 0 });
  assistant.ask.mockResolvedValue({ answer: 'All four websites are up.', proposal: null, model: 'test-model', usage: null, used_fallback: false, context_errors: 0 });
});

describe('the limiter is in front of every route', () => {
  it('registers its own limiter before the first route', () => {
    // A route registered above the limiter would be the one endpoint with no
    // ceiling — the kind of thing that only shows up in an incident.
    expect(router.stack[0].route).toBeUndefined();
    const firstRoute = router.stack.findIndex((l) => l.route);
    expect(router.stack.findIndex((l) => !l.route && l.name !== 'router')).toBeLessThan(firstRoute);
  });
});

describe('the credential', () => {
  it('connects, audits the attempt and returns no token', async () => {
    const res = await request(app).post('/hostinger/credential').send({ token: TOKEN, label: 'ops' });

    expect(res.status).toBe(201);
    expect(credentials.connect).toHaveBeenCalledWith({ token: TOKEN, label: 'ops', actorId: ACTOR.id });
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'hostinger.credential.connect', 'hostinger_credential', 'cred-1', expect.anything());
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(JSON.stringify(auditData())).not.toContain(TOKEN);
  });

  it('answers 200 rather than 201 when the token did not change', async () => {
    credentials.connect.mockResolvedValue({ state: 'connected', unchanged: true, credential: { id: 'cred-1', hint: '…sRk' } });
    const res = await request(app).post('/hostinger/credential').send({ token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.unchanged).toBe(true);
    expect(auditData().unchanged).toBe(true);
  });

  it('refuses a token with whitespace in it', async () => {
    const res = await request(app).post('/hostinger/credential').send({ token: `${TOKEN} and some notes` });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.fields).toHaveProperty('token');
    expect(credentials.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it('reports a verification failure as 502, not as a success', async () => {
    credentials.reverify.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    const res = await request(app).post('/hostinger/credential/verify').send();

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(auditData().ok).toBe(false);
  });

  it('status never carries the token, and keeps a short history', async () => {
    const res = await request(app).get('/hostinger/status');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('connected');
    expect(res.body.history).toHaveLength(1);
    expect(credentials.history).toHaveBeenCalledWith({ limit: 10 });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });
});

describe('operations', () => {
  it('runs a read the catalogue allows and audits it with the public parameters', async () => {
    const res = await request(app).post('/hostinger/operations/read').send({ operation: 'vps.get', params: { path: { virtualMachineId: 7 } } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ operation: 'vps.get', data: { items: [{ id: 7 }] } });
    expect(operations.read).toHaveBeenCalledWith({ operationId: 'vps.get', params: { path: { virtualMachineId: 7 } }, token: TOKEN });
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'hostinger.read', 'hostinger_operation', 'vps.get', expect.objectContaining({ ok: true }));
  });

  it('maps an upstream refusal onto the response instead of a 200', async () => {
    operations.read.mockResolvedValue({
      ok: false,
      status: 403,
      error: { code: 'HOSTINGER_FORBIDDEN', message: 'Not allowed', fields: { domain: 'reserved' }, correlationId: 'corr-1' },
    });
    const res = await request(app).post('/hostinger/operations/read').send({ operation: 'hosting.website.delete', params: { path: { domain: 'x.com' } } });

    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: 'HOSTINGER_FORBIDDEN', message: 'Not allowed', fields: { domain: 'reserved' }, correlation_id: 'corr-1' });
    expect(auditData().ok).toBe(false);
  });

  it('falls back to 502 when an upstream failure arrives with no usable status', async () => {
    operations.read.mockResolvedValue({ ok: false, status: 0, error: { code: 'HOSTINGER_NETWORK', message: 'no route to host' } });
    const res = await request(app).post('/hostinger/operations/read').send({ operation: 'vps.list', params: {} });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('HOSTINGER_NETWORK');
  });

  it('refuses an operation name the catalogue never defined', async () => {
    const hostingerError = new credentials.HostingerError(400, 'HOSTINGER_UNKNOWN_OPERATION', 'Unknown operation');
    operations.read.mockRejectedValue(hostingerError);

    const res = await request(app).post('/hostinger/operations/read').send({ operation: 'vps.format.everything', params: {} });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('HOSTINGER_UNKNOWN_OPERATION');
    expect(audit).not.toHaveBeenCalled();
  });

  it('stores a plan and audits which operation it was for', async () => {
    const res = await request(app).post('/hostinger/operations/plan').send({ operation: 'vps.restart', params: { path: { virtualMachineId: 7 } } });

    expect(res.status).toBe(201);
    expect(res.body.approval_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'hostinger.plan', 'hostinger_approval', '11111111-1111-4111-8111-111111111111', { operation: 'vps.restart', safety: 'mutate' });
  });

  it('never records a re-supplied secret in the audit row', async () => {
    const res = await request(app).post('/hostinger/operations/execute').send({
      operation: 'vps.recovery',
      approval_id: '11111111-1111-4111-8111-111111111111',
      confirmation: 'vps.recovery',
      secrets: { root_password: 'correct-horse-battery-staple' },
    });

    expect(res.status).toBe(200);
    expect(operations.execute).toHaveBeenCalledWith(expect.objectContaining({ secrets: { root_password: 'correct-horse-battery-staple' }, actorId: ACTOR.id }));
    expect(JSON.stringify(auditData())).not.toContain('correct-horse-battery-staple');
    expect(JSON.stringify(res.body)).not.toContain('correct-horse-battery-staple');
  });

  it('passes a refusal to execute through with its own status and code', async () => {
    operations.execute.mockRejectedValue(new credentials.HostingerError(400, 'HOSTINGER_CONFIRMATION_REQUIRED', 'Type vps.recovery to confirm this operation', { expected: 'vps.recovery' }));
    const res = await request(app).post('/hostinger/operations/execute').send({
      operation: 'vps.recovery',
      approval_id: '11111111-1111-4111-8111-111111111111',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'HOSTINGER_CONFIRMATION_REQUIRED', message: 'Type vps.recovery to confirm this operation', fields: { expected: 'vps.recovery' } });
  });

  it('rejects an approval id that is not a uuid before the service sees it', async () => {
    const res = await request(app).post('/hostinger/operations/execute').send({ operation: 'vps.restart', approval_id: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty('approval_id');
    expect(operations.execute).not.toHaveBeenCalled();
  });

  it('rejects an unexpected key in a request body', async () => {
    const res = await request(app).post('/hostinger/operations/plan').send({ operation: 'vps.restart', params: {}, actor: 'somebody-else' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(operations.plan).not.toHaveBeenCalled();
  });

  it('lists only this operator’s pending approvals and can deny one', async () => {
    operations.pendingApprovals.mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111', operation: 'vps.restart' }]);
    operations.deny.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', operation: 'vps.restart' });

    const listed = await request(app).get('/hostinger/approvals?limit=5');
    expect(listed.body.approvals).toHaveLength(1);
    expect(operations.pendingApprovals).toHaveBeenCalledWith({ actorId: ACTOR.id, limit: 5 });

    const denied = await request(app).post('/hostinger/approvals/11111111-1111-4111-8111-111111111111/deny').send();
    expect(denied.status).toBe(200);
    expect(operations.deny).toHaveBeenCalledWith({ approvalId: '11111111-1111-4111-8111-111111111111', actorId: ACTOR.id });
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'hostinger.deny', 'hostinger_approval', '11111111-1111-4111-8111-111111111111', { operation: 'vps.restart' });
  });

  it('reads back only this module’s history', async () => {
    operations.history.mockResolvedValue({ rows: [{ id: 1, action: 'hostinger.plan' }], total: 1 });
    const res = await request(app).get('/hostinger/history?limit=10&action=hostinger.plan');

    expect(res.body.total).toBe(1);
    expect(operations.history).toHaveBeenCalledWith({ limit: 10, offset: undefined, action: 'hostinger.plan' });
  });
});

describe('the assistant', () => {
  it('masks a pasted token before it is written to the audit row', async () => {
    // The route is the last place the raw question exists. Below it, the
    // service scrubs what it sends; above it, the column outlives the session.
    assistant.maskShapedCredentials.mockReturnValue('[REDACTED]');
    const res = await request(app).post('/hostinger/assistant').send({ question: `is this right? ${TOKEN}` });

    expect(res.status).toBe(200);
    expect(assistant.ask).toHaveBeenCalledWith({ question: `is this right? ${TOKEN}`, actorId: ACTOR.id });
    expect(auditData().question).toBe('[REDACTED]');
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'hostinger.assistant.ask', 'hostinger_assistant', null, expect.objectContaining({ question: '[REDACTED]' }));
    expect(JSON.stringify(auditData())).not.toContain(TOKEN);
  });

  it('records which operation was proposed, and whether it was rejected', async () => {
    assistant.ask.mockResolvedValue({ answer: 'No.', proposal: { rejected: true, reason: 'that operation does not exist' } });
    await request(app).post('/hostinger/assistant').send({ question: 'format the vps' });

    expect(auditData()).toMatchObject({ proposed: null, rejected: true });
  });

  it('refuses a question too short to answer', async () => {
    const res = await request(app).post('/hostinger/assistant').send({ question: 'hi' });

    expect(res.status).toBe(400);
    expect(assistant.ask).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  it('turns an unexpected error into a generic 500 with no internals in it', async () => {
    operations.dashboard.mockRejectedValue(new Error(`pg: connection to postgres://user:${TOKEN}@db failed`));
    const res = await request(app).get('/hostinger/dashboard');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'HOSTINGER_ERROR', message: 'The hosting console hit an internal error.' } });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(JSON.stringify(res.body)).not.toContain('pg: connection');
    expect(logger.error).toHaveBeenCalled();
  });

  it('reports an internal error with the code the frontend knows how to read', async () => {
    credentials.status.mockRejectedValue(Object.assign(new Error('bad state'), { status: 503, code: 'HOSTINGER_NOT_CONFIGURED' }));
    const res = await request(app).get('/hostinger/status');

    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({ code: 'HOSTINGER_NOT_CONFIGURED', message: 'bad state' });
  });
});
