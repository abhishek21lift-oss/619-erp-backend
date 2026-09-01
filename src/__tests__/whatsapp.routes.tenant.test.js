// Tenant isolation and authorisation on Settings → Integrations → WhatsApp.
//
// The organization must come from the SESSION and nowhere else. lib/tenant-db.js
// records why: `?organization_id=` and body fields were deliberately removed
// because the RLS GUC and the application filter could then disagree about the
// active tenant within one request. These routes must not reintroduce that.
//
// The second property here is that the gateway is never asked to act for an
// organization the caller did not authenticate as — the gateway cross-checks
// the header against the instance's stored owner, but a backend that sent the
// wrong one would be the bug the cross-check exists to catch.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.WA_GATEWAY_URL = 'http://gateway.test:8080';
process.env.WA_GATEWAY_KEY = 'test-gateway-key-at-least-32-characters!!';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const INSTANCE_A = 'aaaaaaaa-0000-4000-8000-000000000001';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

// A controllable session. Each test sets it before calling.
//
// The `mock` prefix is required, not stylistic: jest.mock() factories are
// hoisted above the file's variable declarations, and Babel rejects any
// out-of-scope reference that is not prefixed this way.
let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = mockCurrentUser;
    next();
  },
  adminOnly: (req, res, next) =>
    req.user && req.user.role === 'admin'
      ? next()
      : res.status(403).json({ error: 'Admin access required' }),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const whatsappRouter = require('../routes/whatsapp');

const app = express();
app.use(express.json());
app.use('/api/integrations/whatsapp', whatsappRouter);

/** Every fetch the route layer made, so we can assert what the gateway was told. */
let fetchCalls;

beforeEach(() => {
  pool.query.mockReset();
  fetchCalls = [];
  mockCurrentUser = { id: 'u1', role: 'admin', organization_id: ORG_A };

  global.fetch = jest.fn(async (url, init) => {
    fetchCalls.push({ url: String(url), headers: (init && init.headers) || {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({ state: 'connecting' }),
    };
  });
});

afterAll(() => {
  delete global.fetch;
});

/** Studio A already has an instance. */
function instanceExists() {
  pool.query.mockResolvedValue({
    rowCount: 1,
    rows: [
      {
        instance_id: INSTANCE_A,
        status: 'connected',
        phone_e164: '+919876543210',
        last_error_code: null,
        connected_at: new Date().toISOString(),
        disconnected_at: null,
        updated_at: new Date().toISOString(),
      },
    ],
  });
}

describe('the organization comes from the session, never from the request', () => {
  it('scopes every instance lookup by the session organization', async () => {
    instanceExists();
    await request(app).get('/api/integrations/whatsapp/status');

    const select = pool.query.mock.calls.find(([q]) => /FROM whatsapp_instances/i.test(q));
    expect(select[0]).toMatch(/WHERE organization_id = \$1/);
    expect(select[1]).toEqual([ORG_A]);
  });

  it('ignores an organization_id supplied in the query string', async () => {
    // The exact shape lib/tenant-db.js removed. If this ever starts passing
    // ORG_B through, the database and the application are scoped differently
    // within one request.
    instanceExists();
    await request(app).get(`/api/integrations/whatsapp/status?organization_id=${ORG_B}`);

    const select = pool.query.mock.calls.find(([q]) => /FROM whatsapp_instances/i.test(q));
    expect(select[1]).toEqual([ORG_A]);
    expect(JSON.stringify(pool.query.mock.calls)).not.toContain(ORG_B);
  });

  it('ignores an organization_id supplied in the body', async () => {
    instanceExists();
    await request(app)
      .post('/api/integrations/whatsapp/connect')
      .send({ organization_id: ORG_B });

    expect(JSON.stringify(pool.query.mock.calls)).not.toContain(ORG_B);
  });

  it('tells the gateway the session organization, not a supplied one', async () => {
    instanceExists();
    await request(app)
      .post('/api/integrations/whatsapp/connect')
      .send({ organization_id: ORG_B });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].headers['X-Org-Id']).toBe(ORG_A);
  });

  it('never lets studio B reach studio A’s instance', async () => {
    // B has no row of its own, so every instance-scoped route must 404 rather
    // than fall through to whatever row happens to exist.
    mockCurrentUser = { id: 'u2', role: 'admin', organization_id: ORG_B };
    pool.query.mockResolvedValue({ rowCount: 0, rows: [] });

    for (const [method, path] of [
      ['get', '/api/integrations/whatsapp/qr'],
      ['post', '/api/integrations/whatsapp/reconnect'],
      ['post', '/api/integrations/whatsapp/disconnect'],
    ]) {
      const res = await request(app)[method](path);
      expect(res.status).toBe(404);
    }

    // And nothing was asked of the gateway on B's behalf.
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('authorisation', () => {
  it('refuses a non-admin', async () => {
    // gate() in server.js is auth + feature flag and says nothing about role —
    // the comment there records a real escalation where a `member` account
    // satisfied every check and read staff data. Connecting a studio's WhatsApp
    // number is an owner action.
    for (const role of ['member', 'trainer', 'manager', 'reception']) {
      mockCurrentUser = { id: 'u3', role, organization_id: ORG_A };
      const res = await request(app).get('/api/integrations/whatsapp/status');
      expect(res.status).toBe(403);
    }
  });

  it('refuses a platform admin with no studio selected', async () => {
    // Pairing a WhatsApp number has no platform-wide meaning. Same 400 and the
    // same wording as writableOrg() in integrations.js.
    mockCurrentUser = { id: 'sa', role: 'admin', organization_id: null };
    const res = await request(app).post('/api/integrations/whatsapp/connect');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Select a studio/i);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('gateway interaction', () => {
  it('sends the shared key and never leaks it in a response', async () => {
    instanceExists();
    const res = await request(app).get('/api/integrations/whatsapp/status');

    expect(fetchCalls[0].headers['X-Gateway-Key']).toBe(process.env.WA_GATEWAY_KEY);
    expect(JSON.stringify(res.body)).not.toContain(process.env.WA_GATEWAY_KEY);
  });

  it('only ever calls the configured gateway host', async () => {
    // The backend makes exactly one kind of outbound call here, to a fixed
    // env-supplied host. No caller-supplied URL is ever fetched.
    instanceExists();
    await request(app).get('/api/integrations/whatsapp/status');
    await request(app).post('/api/integrations/whatsapp/reconnect');

    for (const call of fetchCalls) {
      expect(call.url.startsWith('http://gateway.test:8080/')).toBe(true);
    }
  });

  it('serves the last known state when the gateway is unreachable', async () => {
    // An unreachable optional service must not turn the settings page into an
    // error page — the card greys out instead.
    instanceExists();
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const res = await request(app).get('/api/integrations/whatsapp/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'connected', stale: true });
  });

  it('reports not-configured rather than failing when the gateway is absent', async () => {
    const savedUrl = process.env.WA_GATEWAY_URL;
    delete process.env.WA_GATEWAY_URL;
    try {
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
      const res = await request(app).get('/api/integrations/whatsapp/status');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'never_connected', configured: false });

      const connect = await request(app).post('/api/integrations/whatsapp/connect');
      expect(connect.status).toBe(503);
      expect(connect.body.code).toBe('GATEWAY_NOT_CONFIGURED');
    } finally {
      process.env.WA_GATEWAY_URL = savedUrl;
    }
  });

  it('passes the gateway’s QR codes through so the UI can word them', async () => {
    // "Expired, press Connect again" and "already paired" need very different
    // words on screen, so the codes are not collapsed into one error.
    instanceExists();
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 410,
      json: async () => ({ error: { code: 'QR_EXPIRED', message: 'gone' } }),
    }));

    const res = await request(app).get('/api/integrations/whatsapp/qr');
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('QR_EXPIRED');
  });

  it('does not store the QR anywhere', async () => {
    // A QR is a pairing credential: anyone who scans it links a device to this
    // studio's WhatsApp. It is proxied, never persisted.
    instanceExists();
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ qr: 'a-real-pairing-credential', expires_in_ms: 20000 }),
    }));

    const res = await request(app).get('/api/integrations/whatsapp/qr');

    expect(res.body.qr).toBe('a-real-pairing-credential');
    expect(JSON.stringify(pool.query.mock.calls)).not.toContain('a-real-pairing-credential');
  });
});

describe('disconnect versus delete', () => {
  it('disconnect keeps the row — reconnecting must not need a new QR', async () => {
    instanceExists();
    await request(app).post('/api/integrations/whatsapp/disconnect');

    const sql = pool.query.mock.calls.map(([q]) => q).join('\n');
    expect(sql).toMatch(/UPDATE whatsapp_instances/i);
    expect(sql).not.toMatch(/DELETE FROM whatsapp_instances/i);
  });

  it('delete removes the row, scoped to this studio', async () => {
    instanceExists();
    await request(app).delete('/api/integrations/whatsapp');

    const del = pool.query.mock.calls.find(([q]) => /DELETE FROM whatsapp_instances/i.test(q));
    expect(del).toBeDefined();
    expect(del[0]).toMatch(/WHERE instance_id = \$1 AND organization_id = \$2/);
    expect(del[1]).toEqual([INSTANCE_A, ORG_A]);
  });

  it('still unlinks locally when the gateway has already forgotten the instance', async () => {
    // Otherwise a studio could be permanently unable to unlink because a
    // service it does not know about is in a state it cannot see.
    instanceExists();
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'INSTANCE_NOT_FOUND', message: 'gone' } }),
    }));

    const res = await request(app).delete('/api/integrations/whatsapp');

    expect(res.status).toBe(200);
    expect(pool.query.mock.calls.some(([q]) => /DELETE FROM whatsapp_instances/i.test(q))).toBe(true);
  });
});
