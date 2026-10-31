// POST/GET /api/pt-os/churn-risk — the follow-up routes.
//
// The list itself is assembled and tested in churn.service.test.js; this file
// proves the adapter: tenant scope on the read, the contacted date contract,
// and the snooze validation that keeps a mark from hiding a client forever.
'use strict';

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => {
  const query = jest.fn();
  return { query, connect: jest.fn(async () => ({ query, release: () => {} })) };
});

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));
jest.mock('../middleware/rbac', () => ({ requireTrainer: (_req, _res, next) => next() }));
jest.mock('../lib/appTime', () => ({
  ...jest.requireActual('../lib/appTime'),
  today: jest.fn(() => '2026-10-30'),
}));
jest.mock('../modules/pt-os/churn.service', () => ({
  buildChurnList: jest.fn(), markFollowup: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const churn = require('../modules/pt-os/churn.service');

const app = express();
app.use(express.json());
app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));

const ORG = '11111111-1111-1111-1111-111111111111';
const ADMIN = { id: 'u-admin', role: 'trainer', organization_id: ORG, trainer_id: null };

const post = (body, clientId = 'cl-1') =>
  request(app).post(`/api/pt-os/churn-risk/${clientId}/followup`).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = ADMIN;
});

describe('GET /churn-risk', () => {
  it('returns the list for the caller\'s studio', async () => {
    const list = { as_of: '2026-10-30', assessed: 0, flagged: 0, bands: {}, rows: [], handled: [] };
    churn.buildChurnList.mockResolvedValue(list);

    const res = await request(app).get('/api/pt-os/churn-risk');

    expect(res.status).toBe(200);
    expect(churn.buildChurnList).toHaveBeenCalledWith(ORG);
    expect(res.body).toEqual({ data: list });
  });
});

describe('POST follow-up', () => {
  beforeEach(() => {
    churn.markFollowup.mockResolvedValue({ id: 'f-1', outcome: 'contacted' });
  });

  it('contacted hides for exactly seven days and trims the note', async () => {
    const res = await post({ outcome: 'contacted', note: ' called ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: { id: 'f-1', outcome: 'contacted' } });
    expect(churn.markFollowup).toHaveBeenCalledWith(ORG, 'cl-1', {
      outcome: 'contacted', snoozeUntil: '2026-11-06', note: 'called', today: '2026-10-30',
    });
  });

  it('snoozed accepts a future date inside 90 days', async () => {
    const res = await post({ outcome: 'snoozed', snooze_until: '2026-11-15' });

    expect(res.status).toBe(201);
    expect(churn.markFollowup).toHaveBeenCalledWith(ORG, 'cl-1', expect.objectContaining({
      outcome: 'snoozed', snoozeUntil: '2026-11-15',
    }));
  });

  it('rejects a snooze without a date, in the past, beyond 90 days, or malformed', async () => {
    for (const body of [
      { outcome: 'snoozed' },
      { outcome: 'snoozed', snooze_until: '2026-10-29' },
      { outcome: 'snoozed', snooze_until: '2027-03-01' },
      { outcome: 'snoozed', snooze_until: 'not-a-date' },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(churn.markFollowup).not.toHaveBeenCalled();
  });

  it('rejects an unknown outcome and an over-long note', async () => {
    expect((await post({ outcome: 'called' })).status).toBe(400);
    expect((await post({ outcome: 'contacted', note: 'x'.repeat(501) })).status).toBe(400);
    expect(churn.markFollowup).not.toHaveBeenCalled();
  });

  it('answers 404 when the service cannot find the client', async () => {
    churn.markFollowup.mockResolvedValue(null);

    const res = await post({ outcome: 'contacted' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  });
});
