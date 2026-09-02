// Pressing Connect must actually start pairing — every time, not just the first.
//
// ── The bug this exists to keep fixed ──────────────────────────────────────
//
// The gateway's registry.create() is idempotent, and idempotent there means it
// does not touch an instance that already exists: it returns that instance's
// current state and starts no socket. The `whatsapp_instances` row, meanwhile,
// is created once and lives forever. So from the second press onwards, every
// Connect hit that branch.
//
// A studio whose first pairing attempt did not complete — nobody scanned in
// time, or the socket closed — was therefore stuck permanently: Connect
// no-opped, no socket opened, no QR was ever written, and GET /qr answered 410
// QR_EXPIRED for good. The settings dialog showed "The code expired. Press
// Show a new code to try again." above a button that did nothing at all. That
// is what production was found doing, and no test caught it because the one
// connect test in whatsapp.routes.tenant.test.js asserts which organization
// the gateway was told, not that pairing restarted.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.WA_GATEWAY_URL = 'http://gateway.test:8080';
process.env.WA_GATEWAY_KEY = 'test-gateway-key-at-least-32-characters!!';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_A = 'aaaaaaaa-0000-4000-8000-000000000001';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  adminOnly: (_req, _res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use('/api/integrations/whatsapp', require('../routes/whatsapp'));

/**
 * The gateway, as a table of responses keyed by "METHOD /path".
 *
 * Keyed rather than sequenced because the assertion that matters is WHICH
 * calls were made — a sequence would pass just as happily if /connect stopped
 * calling reconnect and something else made one call instead.
 */
let responses;
let calls;

function gatewayReplies(map) {
  responses = map;
}

/** Studio A's row, in whatever state the test needs. */
function rowInState(status) {
  pool.query.mockImplementation(async (sql) => {
    if (/FROM whatsapp_instances/i.test(sql)) {
      return {
        rowCount: 1,
        rows: [{
          instance_id: INSTANCE_A,
          status,
          phone_e164: null,
          last_error_code: null,
          connected_at: null,
          disconnected_at: null,
          updated_at: new Date().toISOString(),
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
}

beforeEach(() => {
  pool.query.mockReset();
  calls = [];
  mockCurrentUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
  responses = {};

  global.fetch = jest.fn(async (url, init) => {
    const method = (init && init.method) || 'GET';
    const path = String(url).replace('http://gateway.test:8080', '');
    calls.push(`${method} ${path}`);

    // Match on the shape of the path, so the instance uuid does not have to be
    // repeated in every test's table.
    const key = `${method} ${path.replace(INSTANCE_A, ':id')}`;
    const reply = responses[key] || { ok: true, status: 200, body: { state: 'connecting' } };
    return { ok: reply.ok, status: reply.status, json: async () => reply.body };
  });
});

afterAll(() => { delete global.fetch; });

const CREATE = 'POST /v1/instances';
const RECONNECT = `POST /v1/instances/${INSTANCE_A}/reconnect`;

describe('Connect on an instance the gateway is not holding open', () => {
  // Every state in which the gateway has no socket. requiresQr() and a plain
  // stop are both here: from the studio's side "press Connect and nothing
  // happens" is the same defect either way.
  for (const dead of ['never_connected', 'disconnected', 'logged_out', 'qr_timeout', 'failed']) {
    it(`restarts pairing when the gateway reports ${dead}`, async () => {
      rowInState(dead);
      gatewayReplies({
        'POST /v1/instances': { ok: true, status: 200, body: { state: dead } },
        'POST /v1/instances/:id/reconnect': { ok: true, status: 202, body: { state: 'connecting' } },
      });

      const res = await request(app).post('/api/integrations/whatsapp/connect');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, state: 'connecting' });
      // The whole point: a create alone would have left no socket open.
      expect(calls).toEqual([CREATE, RECONNECT]);
    });
  }

  it('reports the state it actually reached, not an assumed one', async () => {
    // A reconnect that comes back still `failed` must not be dressed up as
    // `connecting` — the card would show pairing in progress that is not.
    rowInState('failed');
    gatewayReplies({
      'POST /v1/instances': { ok: true, status: 200, body: { state: 'failed' } },
      'POST /v1/instances/:id/reconnect': { ok: true, status: 202, body: { state: 'reconnecting' } },
    });

    const res = await request(app).post('/api/integrations/whatsapp/connect');
    expect(res.body.state).toBe('reconnecting');
  });
});

describe('Connect on an instance that is already live', () => {
  for (const live of ['connecting', 'connected', 'reconnecting']) {
    it(`leaves a ${live} instance alone`, async () => {
      // Restarting a live pairing would drop the QR the studio is looking at,
      // or — for `connected` — the device link itself.
      rowInState(live);
      gatewayReplies({
        'POST /v1/instances': { ok: true, status: 200, body: { state: live } },
      });

      const res = await request(app).post('/api/integrations/whatsapp/connect');

      expect(res.status).toBe(200);
      expect(res.body.state).toBe(live);
      expect(calls).toEqual([CREATE]);
    });
  }

  it('treats a conflict on restart as connected rather than an error', async () => {
    // The gateway refuses to reconnect something already connected. Racing a
    // scan that completed between the create and the reconnect is not a
    // failure — the studio asked to be connected and it is.
    rowInState('disconnected');
    gatewayReplies({
      'POST /v1/instances': { ok: true, status: 200, body: { state: 'disconnected' } },
      'POST /v1/instances/:id/reconnect': {
        ok: false, status: 409, body: { error: { code: 'INSTANCE_CONFLICT', message: 'already connected' } },
      },
    });

    const res = await request(app).post('/api/integrations/whatsapp/connect');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, state: 'connected' });
  });

  it('surfaces a genuine restart failure instead of claiming success', async () => {
    rowInState('disconnected');
    gatewayReplies({
      'POST /v1/instances': { ok: true, status: 200, body: { state: 'disconnected' } },
      'POST /v1/instances/:id/reconnect': {
        ok: false, status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } },
      },
    });

    const res = await request(app).post('/api/integrations/whatsapp/connect');

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('INTERNAL');
  });
});

describe('the row follows the connect', () => {
  it('moves the stored status to the state pairing reached', async () => {
    // Otherwise the card behind the pairing dialog keeps reporting
    // `disconnected` while a QR is being offered, which reads as a failure.
    rowInState('disconnected');
    gatewayReplies({
      'POST /v1/instances': { ok: true, status: 200, body: { state: 'disconnected' } },
      'POST /v1/instances/:id/reconnect': { ok: true, status: 202, body: { state: 'connecting' } },
    });

    await request(app).post('/api/integrations/whatsapp/connect');

    const update = pool.query.mock.calls.find(([q]) => /UPDATE whatsapp_instances/i.test(q));
    expect(update).toBeDefined();
    expect(update[0]).toMatch(/WHERE instance_id = \$1 AND organization_id = \$2/);
    expect(update[1]).toEqual([INSTANCE_A, ORG_A, 'connecting']);
  });

  it('does not write when nothing changed', async () => {
    rowInState('connecting');
    gatewayReplies({
      'POST /v1/instances': { ok: true, status: 200, body: { state: 'connecting' } },
    });

    await request(app).post('/api/integrations/whatsapp/connect');

    expect(pool.query.mock.calls.some(([q]) => /UPDATE whatsapp_instances/i.test(q))).toBe(false);
  });
});

describe('the first connect a studio ever makes', () => {
  it('creates the row and does not need a second call to start pairing', async () => {
    // The create DOES start a socket for an instance the gateway has never
    // seen, so the restart branch must not fire here — it would reset a
    // pairing one round old.
    let inserted = false;
    pool.query.mockImplementation(async (sql) => {
      if (/INSERT INTO whatsapp_instances/i.test(sql)) { inserted = true; return { rowCount: 1, rows: [] }; }
      if (/FROM whatsapp_instances/i.test(sql)) {
        if (!inserted) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{ instance_id: INSTANCE_A, status: 'connecting', phone_e164: null, last_error_code: null,
                   connected_at: null, disconnected_at: null, updated_at: new Date().toISOString() }],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    gatewayReplies({ 'POST /v1/instances': { ok: true, status: 200, body: { state: 'connecting' } } });

    const res = await request(app).post('/api/integrations/whatsapp/connect');

    expect(res.status).toBe(200);
    expect(calls).toEqual([CREATE]);
  });
});
