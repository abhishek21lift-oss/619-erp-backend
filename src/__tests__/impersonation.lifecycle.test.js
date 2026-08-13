// Impersonation must be auditable end to end, and structurally so.
//
// Three properties, each of which was previously either absent or a convention:
//
//   1. START is audited.                 (was already true)
//   2. WRITES are audited whether or not the handler cooperates. Before this,
//      attribution came from lib/activityLog.js, which only stamps a row if the
//      handler chooses to call it — a route that mutates and never calls
//      logActivity produced no record at all.
//   3. END is audited.                   (there was no server-side exit at all)
//
// Plus the property that makes (2) worth having: the audit is FAIL-CLOSED. If
// the row cannot be written, the write does not happen. A best-effort insert
// would mean a privileged cross-tenant action could occur with nothing
// recording it, and "no row" would be indistinguishable from "nothing
// happened" — the one thing an audit trail must never be.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

jest.mock('../db/pool', () => ({ query: jest.fn(async () => ({ rows: [{ id: 'audit-1' }] })), connect: jest.fn() }));
jest.mock('../lib/subscription', () => ({ computeAccess: () => ({ allowed: true }) }));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const { recordImpersonatedWrite } = require('../middleware/impersonationAudit');
const { auth } = require('../middleware/auth');

const OPERATOR = { id: 'usr-platform', name: 'Platform Op' };
const STUDIO_ADMIN = {
  id: 'usr-studio-admin', name: 'Studio Owner', email: 'a@b.com', role: 'admin',
  organization_id: 'org-a', is_active: true, token_version: 1,
};

function tokenFor({ ro }) {
  return jwt.sign(
    {
      id: STUDIO_ADMIN.id,
      token_version: 1,
      jti: 'session-1',
      imp: { by: OPERATOR.id, byName: OPERATOR.name, ro, org: 'org-a', jti: 'session-1' },
    },
    process.env.JWT_SECRET,
    { expiresIn: '5m' },
  );
}

/** An app whose handler writes NOTHING to the audit log — the point of test (2). */
function appWithUncooperativeHandler() {
  const app = express();
  app.use(express.json());
  app.post('/api/thing', auth, (req, res) => res.json({ ok: true }));
  app.get('/api/thing', auth, (req, res) => res.json({ ok: true }));
  return app;
}

/** pool.query answers: the user lookup, then the audit insert. */
function mockUserThenAudit() {
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql) => {
    if (/FROM users/i.test(sql)) return { rows: [STUDIO_ADMIN] };
    if (/INSERT INTO activity_log/i.test(sql)) return { rows: [{ id: 'audit-1' }] };
    return { rows: [] };
  });
}

beforeEach(() => { mockUserThenAudit(); });

describe('impersonated writes are audited structurally', () => {
  it('records a write even when the handler never calls logActivity', async () => {
    const res = await request(appWithUncooperativeHandler())
      .post('/api/thing')
      .set('Authorization', `Bearer ${tokenFor({ ro: false })}`)
      .send({ any: 'payload' });

    expect(res.status).toBe(200);

    const audit = pool.query.mock.calls.find(([sql]) => /INSERT INTO activity_log/i.test(sql));
    expect(audit).toBeDefined();
    expect(audit[1]).toContain('impersonated.write');
    // The row must name who was really behind it, not just the studio admin.
    const payload = JSON.parse(audit[1].find((v) => typeof v === 'string' && v.includes('_impersonated_by')));
    expect(payload._impersonated_by).toBe(OPERATOR.id);
    expect(payload._impersonated_by_name).toBe(OPERATOR.name);
    expect(payload.mode).toBe('full');
  });

  it('does not write an audit row for a read', async () => {
    await request(appWithUncooperativeHandler())
      .get('/api/thing')
      .set('Authorization', `Bearer ${tokenFor({ ro: false })}`);

    const audit = pool.query.mock.calls.find(([sql]) => /INSERT INTO activity_log/i.test(sql));
    expect(audit).toBeUndefined();
  });

  it('never reaches the audit for a read-only session, which is refused first', async () => {
    const res = await request(appWithUncooperativeHandler())
      .post('/api/thing')
      .set('Authorization', `Bearer ${tokenFor({ ro: true })}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('IMPERSONATION_READONLY');
    const audit = pool.query.mock.calls.find(([sql]) => /INSERT INTO activity_log/i.test(sql));
    expect(audit).toBeUndefined();
  });

  it('leaves ordinary tenant traffic completely alone', async () => {
    const plain = jwt.sign({ id: STUDIO_ADMIN.id, token_version: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const res = await request(appWithUncooperativeHandler())
      .post('/api/thing').set('Authorization', `Bearer ${plain}`).send({});

    expect(res.status).toBe(200);
    const audit = pool.query.mock.calls.find(([sql]) => /INSERT INTO activity_log/i.test(sql));
    expect(audit).toBeUndefined();
  });
});

describe('the audit is fail-closed', () => {
  it('REFUSES the write with 503 when the audit row cannot be committed', async () => {
    pool.query.mockReset();
    pool.query.mockImplementation(async (sql) => {
      if (/FROM users/i.test(sql)) return { rows: [STUDIO_ADMIN] };
      if (/INSERT INTO activity_log/i.test(sql)) throw new Error('audit table unavailable');
      return { rows: [] };
    });

    const res = await request(appWithUncooperativeHandler())
      .post('/api/thing')
      .set('Authorization', `Bearer ${tokenFor({ ro: false })}`)
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AUDIT_UNAVAILABLE');
  });

  it('does not run the handler when the audit fails', async () => {
    const handler = jest.fn((req, res) => res.json({ ok: true }));
    pool.query.mockReset();
    pool.query.mockImplementation(async (sql) => {
      if (/FROM users/i.test(sql)) return { rows: [STUDIO_ADMIN] };
      if (/INSERT INTO activity_log/i.test(sql)) throw new Error('down');
      return { rows: [] };
    });

    const app = express();
    app.use(express.json());
    app.post('/api/thing', auth, handler);

    await request(app).post('/api/thing')
      .set('Authorization', `Bearer ${tokenFor({ ro: false })}`).send({});

    expect(handler).not.toHaveBeenCalled();
  });

  it('reports failure rather than throwing, so auth can answer 503 cleanly', async () => {
    pool.query.mockReset();
    pool.query.mockRejectedValue(new Error('nope'));
    const out = await recordImpersonatedWrite({
      method: 'POST', originalUrl: '/api/x', headers: {},
      user: { id: 'u', organization_id: 'org-a' },
      impersonation: { by: 'op', byName: 'Op', ro: false },
    });
    expect(out.ok).toBe(false);
  });

  it('is a no-op with no impersonation, so it cannot fail ordinary requests', async () => {
    pool.query.mockReset();
    pool.query.mockRejectedValue(new Error('would fail if called'));
    const out = await recordImpersonatedWrite({
      method: 'POST', originalUrl: '/api/x', headers: {}, user: { id: 'u' },
    });
    expect(out).toEqual({ ok: true, id: null });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('the session end is recorded server-side', () => {
  it('POST /impersonation/end writes user_impersonation_ended', async () => {
    const calls = [];
    jest.isolateModules(() => {
      jest.doMock('../modules/platform/super-admin/shared', () => ({
        IMPERSONATION_TTL: '30m',
        jwt: require('jsonwebtoken'),
        pool: { query: jest.fn(async () => ({ rows: [] })) },
        audit: async (...args) => { calls.push(args); },
      }));

      const router = require('../modules/platform/super-admin/impersonation');
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = { id: OPERATOR.id, role: 'super_admin' }; next(); });
      app.use('/api/super-admin', router);

      return request(app)
        .post('/api/super-admin/impersonation/end')
        .send({ organization_id: 'org-a', admin_id: STUDIO_ADMIN.id, jti: 'session-1' })
        .then((res) => {
          expect(res.status).toBe(200);
          expect(res.body.data.ended).toBe(true);
          const [, action, , entityId, meta] = calls[0];
          expect(action).toBe('user_impersonation_ended');
          expect(entityId).toBe(STUDIO_ADMIN.id);
          expect(meta.jti).toBe('session-1');
          expect(meta.reason).toBe('manual');
        });
    });
  });
});

describe('the exit route inherits the platform mount, not the impersonated identity', () => {
  it('is registered on the super-admin router, which is guarded by requireSuperAdmin', () => {
    const fs = require('fs');
    const path = require('path');
    // The mount in server.js applies auth -> requireSuperAdmin ->
    // requireSuperAdminMfa to this whole router; the route must live there and
    // not on a tenant mount, or an impersonated studio admin could call it.
    const mount = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    expect(mount).toMatch(/app\.use\('\/api\/super-admin',\s*auth,\s*requireSuperAdmin,\s*requireSuperAdminMfa/);

    const src = fs.readFileSync(
      path.join(__dirname, '../modules/platform/super-admin/impersonation.js'), 'utf8');
    expect(src).toMatch(/router\.post\(\s*'\/impersonation\/end'/);
  });
});
