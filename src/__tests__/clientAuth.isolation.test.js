// Client logins, and the blast radius of getting one.
//
// This suite exists because activating client accounts changes what an
// authenticated token can be. Until now every account in the system belonged
// to studio staff, so "authenticated" and "trusted with the studio's data"
// were the same thing and a lot of read routes were written that way. Handing
// a login to every paying client ends that, and the routes did not know.
//
// So the assertions here are mostly about what a client CANNOT reach. They are
// the load-bearing half of the feature: the activation flow working is a
// convenience, the isolation holding is the reason it is allowed to ship.

const express = require('express');
const request = require('supertest');

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

const pool = require('../db/pool');
const { requireTrainer, requireClient, ROLES, ALL_ROLES } = require('../middleware/rbac');

/** An app that injects a given req.user, then applies the gate under test. */
function appWith(user, gate, handler = (req, res) => res.json({ reached: true })) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.get('/probe', gate, handler);
  return app;
}

const CLIENT_USER = {
  id: 'usr-client-1', role: 'member',
  organization_id: 'org-a', pt_client_id: 'ptc-1', trainer_id: 'trn-1',
};

describe('requireTrainer — the back office', () => {
  it('refuses a client account', async () => {
    // The whole point. Before this gate, GET /api/pt-os/clients answered any
    // authenticated caller — which was survivable only while no account held
    // the `member` role. Activation creates those accounts by the hundred.
    const res = await request(appWith(CLIENT_USER, requireTrainer)).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.reached).toBeUndefined();
  });

  it('refuses an unauthenticated caller with 401, not 403', async () => {
    // Different answers on purpose: 401 means "log in", 403 means "you are
    // logged in and this is not for you". Collapsing them sends a client with
    // a valid session to the login page, where they log in again and land back
    // here in a loop.
    const res = await request(appWith(undefined, requireTrainer)).get('/probe');
    expect(res.status).toBe(401);
  });

  it('admits the trainer of a studio, and only the trainer', async () => {
    const ok = await request(appWith({ id: 'u', role: ROLES.TRAINER, organization_id: 'org-a' }, requireTrainer)).get('/probe');
    expect(ok.status).toBe(200);
    // Exactly three roles exist; of them, only the trainer runs a studio.
    expect([...ALL_ROLES].sort()).toEqual(['member', 'super_admin', 'trainer']);
  });

  it('refuses a trainer with no studio — there would be no tenant to scope by', async () => {
    const res = await request(appWith({ id: 'u', role: 'trainer', organization_id: null }, requireTrainer)).get('/probe');
    expect(res.status).toBe(403);
  });

  it('refuses the platform operator: super_admin is not a studio role', async () => {
    // It used to pass every studio gate. The operator reaches a studio only by
    // impersonation, which loads the studio's own trainer as req.user.
    const res = await request(appWith({ id: 'u', role: 'super_admin', organization_id: null }, requireTrainer)).get('/probe');
    expect(res.status).toBe(403);
  });

  it('refuses every removed staff role instead of mapping it onto trainer', async () => {
    // normalizeRole() used to turn these into 'trainer'. A stale row carrying
    // one is refused — the database constraint (migration 208) makes such a
    // row impossible, and this makes sure it could not be promoted if it
    // existed.
    for (const role of ['admin', 'manager', 'reception', 'receptionist', 'staff', 'owner']) {
      const res = await request(appWith({ id: 'u', role, organization_id: 'org-a' }, requireTrainer)).get('/probe');
      expect([role, res.status]).toEqual([role, 403]);
    }
  });

  it('is an allow-list, so an unknown role is refused rather than admitted', async () => {
    // The asymmetry that decides how this is written. A new role forgotten
    // here gets a visible 403; a new role forgotten in a deny-list-shaped
    // check gets the studio's whole client list, and nobody finds out.
    const res = await request(appWith({ id: 'u', role: 'partner_api' }, requireTrainer)).get('/probe');
    expect(res.status).toBe(403);
  });

  it('does not treat `member` as staff under any casing or alias', async () => {
    for (const role of ['member', 'Member', 'MEMBER', 'client']) {
      const res = await request(appWith({ id: 'u', role }, requireTrainer)).get('/probe');
      expect([role, res.status]).toEqual([role, 403]);
    }
  });
});

describe('requireClient — the client portal', () => {
  it('admits a client linked to a client record', async () => {
    const res = await request(appWith(CLIENT_USER, requireClient)).get('/probe');
    expect(res.status).toBe(200);
  });

  it('refuses a `member` row with no client link', async () => {
    // A half-built account. Serving it an empty profile is worse than refusing
    // it, because an empty profile reads as "your data was lost".
    const res = await request(appWith({ id: 'u', role: 'member', pt_client_id: null }, requireClient)).get('/probe');
    expect(res.status).toBe(403);
  });

  it('refuses the trainer and the platform operator', async () => {
    // Not a courtesy check. Every query behind this gate scopes to
    // req.user.pt_client_id, which is null for them; letting one through
    // would run `WHERE client_id IS NULL` and return whatever that matches.
    for (const role of ['trainer', 'super_admin']) {
      const res = await request(appWith({ id: 'u', role, pt_client_id: null }, requireClient)).get('/probe');
      expect([role, res.status]).toEqual([role, 403]);
    }
  });

  it('refuses a trainer even if a pt_client_id is somehow set on their row', async () => {
    // Role is checked as well as the link, so a stray column value on the
    // trainer's account cannot turn into portal access.
    const res = await request(appWith({ id: 'u', role: 'trainer', pt_client_id: 'ptc-1' }, requireClient)).get('/probe');
    expect(res.status).toBe(403);
  });
});

describe('the client portal reads only the caller', () => {
  const portal = require('../modules/client-portal/client-portal.routes');

  function portalApp(user) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api/me', portal);
    return app;
  }

  beforeEach(() => pool.query.mockReset());

  it('scopes every route to the session client id, not to anything in the request', async () => {
    // The single rule the module is built on. Asserted per route rather than
    // once, because the failure mode is one handler added later that takes an
    // :id — and that handler would pass a spot check of the others.
    for (const path of ['/api/me/profile', '/api/me/membership', '/api/me/payments', '/api/me/attendance']) {
      pool.query.mockReset();
      pool.query.mockResolvedValue({ rows: [{ id: 'ptc-1' }] });

      await request(portalApp(CLIENT_USER)).get(path);

      const [, params] = pool.query.mock.calls[0];
      expect([path, params[0]]).toEqual([path, 'ptc-1']);
    }
  });

  it('ignores a client id supplied in the query string', async () => {
    // The IDOR attempt. There is no parameter to honour, which is a stronger
    // guarantee than checking that a supplied id matches the session — a check
    // can be forgotten on the next route, an absent parameter cannot.
    pool.query.mockResolvedValue({ rows: [{ id: 'ptc-1' }] });

    await request(portalApp(CLIENT_USER)).get('/api/me/profile?client_id=ptc-victim&id=ptc-victim');

    const [, params] = pool.query.mock.calls[0];
    expect(params).toContain('ptc-1');
    expect(params).not.toContain('ptc-victim');
  });

  it('also filters by organization, so a mislinked account cannot read across tenants', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'ptc-1' }] });
    await request(portalApp(CLIENT_USER)).get('/api/me/profile');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/organization_id = \$2/);
    expect(params[1]).toBe('org-a');
  });

  it('never selects the studio’s commission on the client’s own membership', async () => {
    // trainer_commission is what the studio keeps out of what the client paid.
    // It sits on the same row as the amounts the client is entitled to see, so
    // the only thing keeping it off their screen is that the column list is an
    // allow-list. A later SELECT * would undo that silently.
    pool.query.mockResolvedValue({ rows: [{ id: 'ptc-1' }] });
    await request(portalApp(CLIENT_USER)).get('/api/me/membership');

    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/trainer_commission/);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
  });

  it('does not leak internal notes on the profile', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'ptc-1' }] });
    await request(portalApp(CLIENT_USER)).get('/api/me/profile');

    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/c\.notes/);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
  });
});
