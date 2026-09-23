'use strict';
// The integrations screen must never again collect a secret it does not use.
//
// ── What was there ─────────────────────────────────────────────────────────
//
// `POST /api/integrations/:id/test` answered {success:true} after checking
// that the submitted string started with 'rzp_' / 'sk_' / 'SG.'. It never
// contacted the provider. `POST /:id/connect` then wrote that string into
// `integrations.api_key` — TEXT, unencrypted — and set status 'connected'.
//
// Nothing in the backend has ever SELECTed api_key. Razorpay, the only payment
// provider that works, reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from the
// environment. So the flow's entire effect was to turn a card green and leave
// a studio owner's live payment secret at rest in plaintext, forever.
//
// Two properties are pinned here, because losing either brings the defect back
// in a form that looks like a feature:
//
//   1. No endpoint on this router accepts a credential.
//   2. A server-managed provider's status comes from server configuration,
//      not from a row — so a stale 'connected' row cannot outrank an unset
//      RAZORPAY_KEY_ID and tell a studio that payments work when they do not.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
const pool = require('../db/pool');

const RAZORPAY_ENV = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'];
const saved = {};
beforeAll(() => { for (const k of RAZORPAY_ENV) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of RAZORPAY_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Every path this router answers, as `METHOD /path`. */
function routesOf(router) {
  return router.stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));
}

describe('the credential-collecting endpoints are gone', () => {
  const router = require('../routes/integrations');

  it('exposes no endpoint that takes an API key', () => {
    const routes = routesOf(router);
    expect(routes).not.toContain('POST /:id/connect');
    expect(routes).not.toContain('POST /:id/test');
  });

  it('still lets a studio clear a row the old flow left behind', () => {
    // Deliberately kept: rows written before the removal still exist, and this
    // is the only way a studio scrubs its own stored secret without waiting
    // for migration 203 to be deployed.
    expect(routesOf(router)).toContain('POST /:id/disconnect');
  });

  it('never names api_key in any statement it runs', () => {
    const src = require('node:fs').readFileSync(require.resolve('../routes/integrations'), 'utf8');
    // The column may be mentioned in prose and nulled on disconnect; what must
    // not reappear is a statement that stores one.
    expect(src).not.toMatch(/api_key\s*=\s*EXCLUDED\.api_key/);
    expect(src).not.toMatch(/INSERT INTO integrations[\s\S]*?api_key[\s\S]*?VALUES/);
  });
});

describe('server-managed provider status comes from the server, not a row', () => {
  const router = require('../routes/integrations');

  /** Drive the GET / handler with a stubbed req/res. */
  async function get(rows) {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows });
    const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
    const req = { user: { role: 'trainer', organization_id: 'org-a' }, headers: {} };
    let payload;
    const res = { json: (p) => { payload = p; } };
    await new Promise((resolve, reject) => {
      layer.route.stack[0].handle(req, res, (err) => (err ? reject(err) : resolve()));
      setTimeout(resolve, 0);
    });
    return payload;
  }

  it('reports razorpay connected when the environment configures it', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    jest.resetModules();
    const out = await get([]);
    const rz = out.find((r) => r.id === 'razorpay');
    expect(rz).toBeDefined();
    expect(rz.managed).toBe('server');
    // The positive half. Without this the pair below would both pass on a
    // handler that hardcoded 'unavailable'.
    expect(rz.status).toBe('connected');
  });

  it('a stale connected row does not survive an unconfigured environment', async () => {
    for (const k of RAZORPAY_ENV) delete process.env[k];
    jest.resetModules();
    const out = await get([
      { id: 'razorpay', name: 'Razorpay', status: 'connected', connected_at: '2026-01-01', last_sync_at: null },
    ]);
    const rz = out.find((r) => r.id === 'razorpay');
    // The row says connected. The server says there are no keys. The server wins.
    expect(rz.status).toBe('unavailable');
  });
});
