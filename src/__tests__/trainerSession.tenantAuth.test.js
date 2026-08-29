'use strict';

/**
 * Regression tests for the trainer session P0 fix
 *
 * These tests ensure that:
 *   1. A client_id supplied by the caller is verified to belong to the caller's organization.
 *   2. A trainer can only schedule sessions for clients that are assigned to them.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

const mockQueries = [];
jest.mock('../db/pool', () => {
  const originalModule = jest.requireActual('../db/pool');
  return {
    ...originalModule,
    query: jest.fn(async (sql, params) => {
      mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });

      // Handle clientInOrg query: SELECT 1 FROM pt_clients WHERE id = $1 AND deleted_at IS NULL AND organization_id = $2
      const clientInOrgMatch = sql.match(/SELECT 1 FROM pt_clients WHERE id = \$1 AND deleted_at IS NULL AND organization_id = \$2/);
      if (clientInOrgMatch && params && params[0] && params[1]) {
        const [clientId, orgId] = params;
        const CLIENT_MAP = {
          'client-in-org': ORG_A,
          'client-no-trainer': ORG_A,
          'client-other-org': ORG_B,
        };
        // console.log(`clientInOrgMatch: clientId=${clientId}, orgId=${orgId}, expectedOrg=${CLIENT_MAP[clientId]}`);
        if (CLIENT_MAP[clientId] === orgId) {
          return { rows: [{ one: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // Handle trainer ownership check: SELECT trainer_id FROM pt_clients WHERE id = $1 AND deleted_at IS NULL
      const trainerCheckMatch = sql.match(/SELECT trainer_id FROM pt_clients WHERE id = \$1 AND deleted_at IS NULL/);
      if (trainerCheckMatch && params && params[0]) {
        const TRAINER_MAP = {
          'client-in-org': 'trainer-1',
          'client-no-trainer': null,
        };
        const trainerId = TRAINER_MAP[params[0]];
        if (trainerId) {
          return { rows: [{ trainer_id: trainerId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    }),
    connect: jest.fn(async () => ({
      query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
      release: jest.fn(),
    })),
  };
});

jest.mock('../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const TRAINER_ID = 'trainer-1';
const CLIENT_IN_ORG = 'client-in-org';
const CLIENT_OTHER_ORG = 'client-other-org';
const CLIENT_NO_TRAINER = 'client-no-trainer';

let mockUser = { id: 'u1', role: 'trainer', organization_id: ORG_A, trainer_id: TRAINER_ID };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireStaff: () => (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/trainers', require('../routes/trainers'));
  return a;
}

beforeEach(() => {
  mockQueries.length = 0;
  mockUser = { id: 'u1', role: 'trainer', organization_id: ORG_A, trainer_id: TRAINER_ID };
});

describe('POST /api/trainers/sessions tenant and trainer ownership checks', () => {
  const baseBody = {
    trainer_id: TRAINER_ID,
    client_id: CLIENT_IN_ORG,
    date: '2025-09-01',
    time: '10:00',
    duration: 60,
    type: 'PT Session',
    notes: 'test',
  };

  test('rejects a client_id from another organization with 404', async () => {
    const res = await request(app())
      .post('/api/trainers/sessions')
      .send({ ...baseBody, client_id: CLIENT_OTHER_ORG });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Client not found');
  });

  test('rejects a trainer creating a session for a client not assigned to them', async () => {
    const res = await request(app())
      .post('/api/trainers/sessions')
      .send({ ...baseBody, client_id: CLIENT_NO_TRAINER });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Trainer not authorized for this client');
  });

  test('allows a trainer to create a session for their own client', async () => {
    const res = await request(app())
      .post('/api/trainers/sessions')
      .send(baseBody);

    expect([200, 201]).toContain(res.status);
  });

  test('allows an admin to create a session for any client in the org', async () => {
    mockUser = { id: 'admin', role: 'admin', organization_id: ORG_A };

    const res = await request(app())
      .post('/api/trainers/sessions')
      .send(baseBody);

    expect([200, 201]).toContain(res.status);
  });

  test('returns 400 when required fields are missing', async () => {
    const res = await request(app())
      .post('/api/trainers/sessions')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('trainer_id, client_id, and date are required');
  });
});
