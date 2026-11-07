// Comp reactivation — the one super-admin action that grants access with no
// payment. The guard worth testing is the reason: without it the audit row
// says a studio was switched back on and nothing says why.
jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/fileStorage', () => ({ saveFile: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'op-1', name: 'Owner', role: 'super_admin' }; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  invalidateUserCache: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const platformRoutes = require('../modules/platform/super-admin.routes');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'op-1', name: 'Owner', role: 'super_admin' }; next(); });
  a.use('/api/super-admin', platformRoutes);
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const calls = () => pool.query.mock.calls.map(([sql, params]) => ({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }));
const call = (re) => calls().find((c) => re.test(c.sql));

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [] });
});

describe('POST /organizations/:id/subscription/reactivate', () => {
  it('refuses a comp reactivation with no reason, before touching the studio', async () => {
    const res = await request(app())
      .post('/api/super-admin/organizations/org-1/subscription/reactivate')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(call(/UPDATE organizations/)).toBeUndefined();
  });

  it('reactivates with the reason on the event and the audit row', async () => {
    const res = await request(app())
      .post('/api/super-admin/organizations/org-1/subscription/reactivate')
      .send({ reason: '  Payment outage, goodwill  ' });

    expect(res.status).toBe(200);
    expect(res.body.data.subscription_status).toBe('active');

    const update = call(/UPDATE organizations SET subscription_status='active'/);
    expect(update.params).toEqual(['org-1']);

    // Trimmed once, and carried into both records — the studio's own history
    // and the platform audit log must answer "why" the same way.
    const event = call(/INSERT INTO subscription_events/);
    expect(JSON.parse(event.params[2])).toEqual({ reason: 'Payment outage, goodwill' });
    const audit = call(/INSERT INTO activity_log/);
    expect(audit.params[5]).toEqual({ reason: 'Payment outage, goodwill' });
  });
});
