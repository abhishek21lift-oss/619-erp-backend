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
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));
jest.mock('../middleware/rbac', () => ({ requireTrainer: (_req, _res, next) => next(),}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));

const ORG = '11111111-1111-1111-1111-111111111111';
const ADMIN = { id: 'u-admin', role: 'trainer', organization_id: ORG, trainer_id: null };
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

function mockDb({ clients = CLIENTS, sets = [], landmarks = [] } = {}) {
  pool.query.mockReset();
  pool.query.mockImplementation((sql) => Promise.resolve({
    rows: /FROM pt_clients/.test(String(sql)) ? clients
      : /FROM workout_sets/.test(String(sql)) ? sets
        : /FROM muscle_volume_landmarks/.test(String(sql)) ? landmarks : [],
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

  it('costs three queries, not three per client', async () => {
    await request(app).get('/api/pt-os/signals');
    // Loading each client's context in turn would be ~10 queries each. For a
    // 34-client studio that is 340 round trips to render a dashboard.
    //
    // Three, not two, since the volume ranges came from the studio's own
    // muscle_volume_landmarks rather than a constant in the engine — and they
    // are resolved ONCE for the sweep, not per client, because the ranges
    // belong to the gym.
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(sqls()[0]).toMatch(/FROM pt_clients/);
    expect(sqls().some((q) => /FROM workout_sets/.test(q))).toBe(true);
    expect(sqls().filter((q) => /FROM muscle_volume_landmarks/.test(q))).toHaveLength(1);
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
    // Neither client-scoped query is trusted because the other was filtered.
    const scoped = sqls().filter((q) => !/muscle_volume_landmarks/.test(q));
    for (const sql of scoped) expect(sql).toMatch(/c\.organization_id = \$1/);
    for (const call of pool.query.mock.calls) expect(call[1][0]).toBe(ORG);
  });

  it('sweeps the whole studio for the trainer — no roster narrowing, whatever is asked', async () => {
    // The trainer owns the studio, so there is no narrower roster to pin to,
    // and a trainer_id in the query string narrows nothing either: the sweep
    // is the same as the client list, which is the whole studio.
    mockUser = TRAINER;
    await request(app).get('/api/pt-os/signals?trainer_id=tr-someone-else');
    for (const [sql, params] of pool.query.mock.calls) {
      if (/muscle_volume_landmarks/.test(String(sql))) continue;
      expect(params[0]).toBe(ORG);
      expect(params[1]).toBeNull();
    }
  });

  it('a member is refused before the sweep runs', async () => {
    mockUser = { id: 'm1', role: 'member', organization_id: ORG, pt_client_id: 'c-1' };
    const res = await request(app).get('/api/pt-os/signals');
    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('answers an empty roster without touching the sets table', async () => {
    mockDb({ clients: [] });
    const res = await request(app).get('/api/pt-os/signals');
    expect(res.status).toBe(200);
    expect(res.body.data.clients).toBe(0);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('the studio\'s ranges reach the sweep', () => {
  it('raises a volume signal measured against what this gym set', async () => {
    mockDb({
      clients: [CLIENTS[0]],
      sets: [{
        client_id: 'a', exercise_name: 'Lat Pulldown', weight_kg: 40, reps: 10,
        completed: true, session_date: ago(2), target_muscle: 'Lats',
      }],
      landmarks: [{ target_muscle: 'lats', mev_sets: 10, mrv_sets: 25 }],
    });

    const res = await request(app).get('/api/pt-os/signals');
    const client = res.body.data.clients_detail.find((c) => c.client_id === 'a');
    const signal = client.signals.find((s) => s.id === 'undertrained');

    // One set against this studio's minimum of ten. Before the fix the engine
    // compared against its own hardcoded "Back: 10" and could not see a
    // per-muscle range at all.
    expect(signal).toBeTruthy();
    expect(signal.evidence).toBe('Lats 1 sets vs 10 minimum');
  });

  it('says nothing about a muscle the studio has set no range for', async () => {
    mockDb({
      clients: [CLIENTS[0]],
      sets: [{
        client_id: 'a', exercise_name: 'Wrist Curl', weight_kg: 10, reps: 15,
        completed: true, session_date: ago(2), target_muscle: 'Forearms',
      }],
      landmarks: [],
    });

    const res = await request(app).get('/api/pt-os/signals');
    // Six of the library's eighteen target muscles have no row. A verdict on
    // one would be a judgement nobody made.
    expect(res.body.data.clients_with_signals).toBe(0);
  });
});

