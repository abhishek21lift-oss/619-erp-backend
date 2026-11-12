'use strict';
// POST /api/ai/copilot/context — the no-model endpoint that returns the
// resolved context object. It is the contract the workspace will read and the
// place the tenant/role refusals happen before any record read.
//
// The engine's own resolution is covered by the context suites; this one
// proves the transport: refusals, the 404 that hides whether a foreign client
// exists, validation, and that the access log carries ids only.

jest.mock('../modules/copilot/context/assemble', () => ({
  assembleContext: jest.fn(),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const request = require('supertest');
const express = require('express');
const { assembleContext } = require('../modules/copilot/context/assemble');
const logger = require('../lib/logger');
const router = require('../modules/copilot/copilot.routes');

const ORG = '11111111-1111-4111-8111-111111111111';
const CONTEXT = {
  version: 1,
  identity: { userId: 'usr-1', name: 'Trainer One', role: 'trainer', trainerId: 'tr-1' },
  tenant: { organizationId: ORG, organizationName: 'Studio A' },
  permissions: { levels: ['READ'], executeRequiresApproval: true },
  client_scope: { policy: 'organization_wide', selected_client_id: null, available_clients: [] },
  client: null,
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (req.headers.authorization === 'Bearer trainer') {
    req.user = {
      id: 'usr-1', name: 'Trainer One', role: 'trainer',
      trainer_id: 'tr-1', organization_id: ORG, organization_name: 'Studio A',
    };
  }
  if (req.headers.authorization === 'Bearer member') {
    req.user = { id: 'usr-2', role: 'member', organization_id: ORG, pt_client_id: 'c-1' };
  }
  next();
});
app.use('/api/ai/copilot', router);
// Mirror the server's error handler: unexpected failures are 500, not a crash.
app.use((err, _req, res, _next) => res.status(500).json({ error: { code: 'INTERNAL' } }));

beforeEach(() => {
  jest.clearAllMocks();
  assembleContext.mockResolvedValue(CONTEXT);
});

describe('refusals', () => {
  test('no authenticated user is 401', async () => {
    const res = await request(app).post('/api/ai/copilot/context').send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(assembleContext).not.toHaveBeenCalled();
  });

  test('a member is 403 and reads no context', async () => {
    const res = await request(app)
      .post('/api/ai/copilot/context')
      .set('authorization', 'Bearer member')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(assembleContext).not.toHaveBeenCalled();
  });

  test('an unauthenticated body tenant cannot stand in for req.user', async () => {
    const res = await request(app)
      .post('/api/ai/copilot/context')
      .send({ organization_id: ORG });

    expect(res.status).toBe(401);
    expect(assembleContext).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  test('a non-string client id is rejected before any read', async () => {
    const res = await request(app)
      .post('/api/ai/copilot/context')
      .set('authorization', 'Bearer trainer')
      .send({ client_id: { $ne: null } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CLIENT_ID');
    expect(assembleContext).not.toHaveBeenCalled();
  });

  test('an over-long client id is rejected', async () => {
    const res = await request(app)
      .post('/api/ai/copilot/context')
      .set('authorization', 'Bearer trainer')
      .send({ client_id: 'x'.repeat(101) });

    expect(res.status).toBe(400);
    expect(assembleContext).not.toHaveBeenCalled();
  });
});

describe('successful resolution', () => {
  test('returns the context object with no client selected', async () => {
    const res = await request(app)
      .post('/api/ai/copilot/context')
      .set('authorization', 'Bearer trainer')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.context).toEqual(CONTEXT);
    expect(assembleContext).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ userId: 'usr-1' }),
        tenant: expect.objectContaining({ organizationId: ORG }),
        clientAccess: expect.objectContaining({ policy: 'organization_wide' }),
      }),
      null
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('a foreign or missing client is the same 404, with no log', async () => {
    assembleContext.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/ai/copilot/context')
      .set('authorization', 'Bearer trainer')
      .send({ client_id: 'c-foreign' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_FOUND');
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('a resolved client read is logged with ids only', async () => {
    assembleContext.mockResolvedValue({ ...CONTEXT, client: { id: 'c-1', name: 'Asha' } });

    const res = await request(app)
      .post('/api/ai/copilot/context')
      .set('authorization', 'Bearer trainer')
      .send({ client_id: 'c-1' });

    expect(res.status).toBe(200);
    expect(logger.info).toHaveBeenCalledTimes(1);

    const [fields, message] = logger.info.mock.calls[0];
    expect(message).toMatch(/client context/i);
    expect(fields).toMatchObject({
      event: 'copilot.context.client_access',
      user_id: 'usr-1',
      organization_id: ORG,
      client_id: 'c-1',
      policy: 'organization_wide',
    });
    // No client name, phone, email or free text in an access log.
    expect(JSON.stringify(fields)).not.toContain('Asha');
  });
});
