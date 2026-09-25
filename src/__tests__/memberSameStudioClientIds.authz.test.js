'use strict';
// A member naming ANOTHER client of their own studio.
//
// memberEscalation.authz.test.js skips every mount on its MEMBER_REACHABLE
// list, and probes the rest with a bare GET. Both blind spots hid the same
// shape: a route on a member-reachable mount (/api/diet, /api/workouts,
// /api/ai) that takes a client_id from the request and checks it only against
// the STUDIO. The org filter holds — the member cannot reach another studio —
// but inside their own studio every other client's record answered.
//
// This file drives those routes directly, with the client_id supplied, and
// asserts a member is refused while the trainer still gets through.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_CLIENT = '22222222-2222-4222-8222-222222222222';

const MEMBER = {
  id: 'member-1', role: 'member', organization_id: ORG,
  pt_client_id: '33333333-3333-4333-8333-333333333333', name: 'A Client',
};
const TRAINER = { id: 'trainer-1', role: 'trainer', organization_id: ORG, name: 'The Trainer' };

jest.mock('../db/pool', () => ({
  query: jest.fn(async () => ({ rows: [{ id: 'x' }], rowCount: 1 })),
  connect: jest.fn(async () => ({
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    release: jest.fn(),
  })),
}));

let mockCurrentUser = MEMBER;
jest.mock('../middleware/auth', () => {
  const actual = jest.requireActual('../middleware/auth');
  return { ...actual, auth: (req, _res, next) => { req.user = { ...mockCurrentUser }; next(); } };
});

const express = require('express');
const request = require('supertest');

function appFor(mount, router) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  return app;
}

const CASES = [
  ['diet', 'get', '/api/diet/tracker', { client_id: OTHER_CLIENT }],
  ['diet', 'put', '/api/diet/tracker', { client_id: OTHER_CLIENT, calories_consumed: 1 }],
  ['diet', 'get', '/api/diet/assignments', { client_id: OTHER_CLIENT }],
  ['workouts', 'get', '/api/workouts/assignments', { client_id: OTHER_CLIENT }],
  ['workouts', 'get', '/api/workouts/plans', { client_id: OTHER_CLIENT }],
];

function send(app, method, url, data) {
  const r = request(app)[method](url);
  return method === 'get' ? r.query(data) : r.send(data);
}

describe('a member cannot name another client of their own studio', () => {
  afterEach(() => { mockCurrentUser = MEMBER; });

  it.each(CASES)('%s: member %s %s is refused', async (mod, method, url, data) => {
    const router = require(`../routes/${mod}`);
    const res = await send(appFor(`/api/${mod}`, router), method, url, data);
    expect(res.status).toBe(403);
  });

  it.each(CASES)('%s: trainer %s %s still gets through', async (mod, method, url, data) => {
    mockCurrentUser = TRAINER;
    const router = require(`../routes/${mod}`);
    const res = await send(appFor(`/api/${mod}`, router), method, url, data);
    expect(res.status).not.toBe(403);
  });

  it('the workouts plan library stays readable to a member without a client_id', async () => {
    const router = require('../routes/workouts');
    const res = await request(appFor('/api/workouts', router)).get('/api/workouts/plans');
    expect(res.status).not.toBe(403);
  });
});

describe('/api/ai is gated by role at the mount', () => {
  it('server.js mounts both /api/ai routers behind studioGate', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    const aiMounts = src.split('\n').filter((l) => /^app\.use\('\/api\/ai',/.test(l));
    expect(aiMounts).toHaveLength(2);
    for (const line of aiMounts) expect(line).toMatch(/studioGate\('ai_suite'\)/);
  });
});

describe('UPI order plan lookup is scoped to the caller\'s studio', () => {
  it('the plans query in POST /create filters on organization_id', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'routes', 'upi-payments.js'), 'utf8');
    const q = src.match(/SELECT id, name, final_amount, duration FROM plans[\s\S]*?`/);
    expect(q).not.toBeNull();
    expect(q[0]).toMatch(/organization_id = \$2/);
  });
});
