// GET /api/pt-os/signals — the roster sweep.
//
// Two things must hold, and the second is the one that could leak.
//
//   1. It sweeps the roster in a bounded number of queries. The obvious shape
//      — loop the clients, load each one's context — is ~10 queries per
//      client, so 34 clients would cost 340 round trips for a dashboard.
//   2. A trainer sees their own clients and nobody else's. GET /clients pins a
//      trainer to their own roster; a signals endpoint that did not would be a
//      way around that, returning names, training history and term dates for
//      the whole studio to someone who cannot list them.
'use strict';

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => {
  const query = jest.fn();
  return { query, connect: jest.fn(async () => ({ query, release: () => {} })) };
});

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
}));
jest.mock('../middleware/rbac', () => ({ requireRole: () => (_req, _res, next) => next() }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));

const ORG = '11111111-1111-1111-1111-111111111111';
const ADMIN = { id: 'u-admin', role: 'admin', organization_id: ORG, trainer_id: null };
const TRAINER = { id: 'u-tr', role: 'trainer', organization_id: ORG, trainer_id: 'tr-1' };

const ago = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/** The live studio in miniature: one training, one paying and silent. */
const CLIENTS = [
  { id: 'a', name: 'Trains', pt_start_date: ago(60), pt_end_date: ago(-30), last_session: ago(2) },
  { id: 'b', name: 'Paying, silent', pt_start_date: ago(60), pt_end_date: ago(-30), last_session: ago(25) },
];

function mockDb({ clients = CLIENTS, sets = [] } = {}) {
  pool.query.mockReset();
  pool.query.mockImplementation((sql) => Promise.resolve({
    rows: /FROM pt_clients/.test(String(sql)) ? clients
      : /FROM workout_sets/.test(String(sql)) ? sets : [],
  }));
}

const sqls = () => pool.query.mock.calls.map(([s]) => String(s).replace(/\s+/g, ' '));

beforeEach(() => { mockUser = ADMIN; mockDb(); });

describe('the sweep', () => {
  it('returns the clients with something to say, worst first', async () => {
    const res = await request(app).get('/api/pt-os/signals');
    expect(res.status).toBe(200);

    const { data } = res.body;
    expect(data.clients).toBe(2);
    expect(data.clients_with_signals).toBe(1);
    // The one who trained this week is counted, not listed.
    expect(data.clients_detail.map((c) => c.client_id)).toEqual(['b']);
    expect(data.clients_detail[0].signals[0].id).toBe('gone_quiet');
  });

  it('costs two queries, not two per client', async () => {
    await request(app).get('/api/pt-os/signals');
    // Loading each client's context in turn would be ~10 queries each. For a
    // 34-client studio that is 340 round trips to render a dashboard.
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(sqls()[0]).toMatch(/FROM pt_clients/);
    expect(sqls()[1]).toMatch(/FROM workout_sets/);
  });

  it('bounds the set pull rather than reading a whole history', async () => {
    await request(app).get('/api/pt-os/signals');
    expect(sqls()[1]).toMatch(/LIMIT \d+/);
    expect(sqls()[1]).toMatch(/session_date >= CURRENT_DATE - \(\$3 \* INTERVAL '1 week'\)/);
  });
});

describe('scoping', () => {
  it('scopes both queries to the studio independently', async () => {
    await request(app).get('/api/pt-os/signals');
    // Neither query is trusted because the other was filtered.
    for (const sql of sqls()) expect(sql).toMatch(/c\.organization_id = \$1/);
    for (const call of pool.query.mock.calls) expect(call[1][0]).toBe(ORG);
  });

  it('pins a trainer to their own clients whatever they ask for', async () => {
    mockUser = TRAINER;
    await request(app).get('/api/pt-os/signals?trainer_id=tr-someone-else');

    // The same rule GET /clients uses. A signals sweep that showed more than
    // the client list would be a way around it.
    for (const call of pool.query.mock.calls) expect(call[1][1]).toBe('tr-1');
  });

  it('lets an admin see the studio, or narrow to one trainer', async () => {
    mockUser = ADMIN;
    await request(app).get('/api/pt-os/signals');
    expect(pool.query.mock.calls[0][1][1]).toBeNull();

    mockDb();
    await request(app).get('/api/pt-os/signals?trainer_id=tr-2');
    expect(pool.query.mock.calls[0][1][1]).toBe('tr-2');
  });

  it('answers an empty roster without touching the sets table', async () => {
    mockDb({ clients: [] });
    const res = await request(app).get('/api/pt-os/signals');
    expect(res.status).toBe(200);
    expect(res.body.data.clients).toBe(0);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
