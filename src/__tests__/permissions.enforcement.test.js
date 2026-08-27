// The role-permission matrix is enforced on the server.
//
// ── RBAC-01 ─────────────────────────────────────────────────────────────────
//
// Settings → Permissions offers sixteen toggles. Before middleware/permissions.js
// they were read by exactly one thing — canSeeByPermission() in the frontend's
// Sidebar.tsx, deciding whether to render a nav link. A repository-wide search
// for `perm_` outside routes/settings.js and its tests returned nothing on the
// backend.
//
// So a studio owner switching perm_trainer_finance off removed a menu item and
// nothing else: GET /api/expenses, GET /api/invoices and GET /api/reports/monthly
// all still answered, because those mounts gate on requireStaff, which includes
// `trainer`. Frontend authorisation is not authorisation.
'use strict';

const mockRows = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async () => ({ rows: mockRows, rowCount: mockRows.length })),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db/pool');
const { requirePermission, invalidatePermissions } = require('../middleware/permissions');

const ORG = '11111111-1111-1111-1111-111111111111';

/** A router gated on `feature`, answering 200 when the gate lets the call past. */
function app(feature, user) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = user; next(); });
  a.get('/thing', requirePermission(feature), (_req, res) => res.json({ ok: true }));
  return a;
}

const trainer = { id: 'u1', role: 'trainer', organization_id: ORG };

beforeEach(() => {
  mockRows.length = 0;
  invalidatePermissions();          // the gate caches per studio for 30s
  delete process.env.PERMISSION_ENFORCE;
  jest.clearAllMocks();
});

describe('a stored toggle actually refuses the request', () => {
  it('trainer + finance:false → 403, not a rendered-away menu item', async () => {
    mockRows.push({ key: 'perm_trainer_finance', value: 'false' });
    const res = await request(app('finance', trainer)).get('/thing');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('trainer + finance:true → allowed', async () => {
    mockRows.push({ key: 'perm_trainer_finance', value: 'true' });
    const res = await request(app('finance', trainer)).get('/thing');
    expect(res.status).toBe(200);
  });

  it('reads the studio\'s own matrix, scoped by organization_id', async () => {
    // system_settings was platform-global until migration 180 — one studio's
    // permission matrix was every studio's. Reading it unscoped here would
    // rebuild that one layer down.
    await request(app('finance', trainer)).get('/thing');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/organization_id = \$1/);
    expect(params).toEqual([ORG]);
    expect(sql).toMatch(/perm/);
  });
});

describe('the shipped defaults apply when a studio has saved nothing', () => {
  // A studio that never opened the permissions screen has no rows at all, so
  // every check falls through to PERM_DEFAULTS. These are the four that change
  // real behaviour on the deploy that turns enforcement on.
  it.each([
    ['trainer',   'finance',        403],
    ['trainer',   'reports',        403],
    ['trainer',   'pt_module',      200],
    ['trainer',   'commissions',    200],
    ['trainer',   'record_payment', 403],
    ['reception', 'pt_module',      403],
    ['reception', 'record_payment', 200],
    ['reception', 'finance',        403],
  ])('%s + %s → %i', async (role, feature, expected) => {
    const res = await request(app(feature, { id: 'u', role, organization_id: ORG })).get('/thing');
    expect(res.status).toBe(expected);
  });

  it('treats receptionist as reception rather than as an unknown role', async () => {
    // Both spellings are live in rbac.js's STAFF_ROLES. A check written against
    // one and not the other is a silent hole.
    const res = await request(app('record_payment', { id: 'u', role: 'receptionist', organization_id: ORG })).get('/thing');
    expect(res.status).toBe(200);
  });
});

describe('roles the matrix has no opinion about', () => {
  it.each(['admin', 'manager', 'super_admin'])('%s passes without a lookup', async (role) => {
    const res = await request(app('finance', { id: 'u', role, organization_id: ORG })).get('/thing');
    expect(res.status).toBe(200);
    // And costs nothing: no query is issued for a caller whose answer cannot
    // change based on the matrix.
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('failure modes', () => {
  it('a database failure DENIES rather than assuming yes', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app('finance', trainer)).get('/thing');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_UNAVAILABLE');
  });

  it('an unknown feature name fails at mount time, not per request', () => {
    // A typo in a route definition should break the boot loudly rather than
    // silently permit every request to that mount.
    expect(() => requirePermission('finence')).toThrow(/not an enforceable feature/);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app('finance', undefined)).get('/thing');
    expect(res.status).toBe(401);
  });
});

describe('PERMISSION_ENFORCE', () => {
  it('report mode allows the request and logs what would have been refused', async () => {
    process.env.PERMISSION_ENFORCE = 'report';
    mockRows.push({ key: 'perm_trainer_finance', value: 'false' });
    const logger = require('../lib/logger');

    const res = await request(app('finance', trainer)).get('/thing');

    expect(res.status).toBe(200);
    const logged = logger.warn.mock.calls.map((c) => c[1]).join(' ');
    expect(logged).toMatch(/permission_would_deny/);
  });

  it('off disables the gate entirely, without even a lookup', async () => {
    process.env.PERMISSION_ENFORCE = 'off';
    mockRows.push({ key: 'perm_trainer_finance', value: 'false' });

    const res = await request(app('finance', trainer)).get('/thing');
    expect(res.status).toBe(200);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('an unrecognised value reads as ON, never as off', async () => {
    // A typo in a deployment variable must not silently disable an
    // authorisation gate. Same strictness as lib/tenantRlsFlag.js.
    process.env.PERMISSION_ENFORCE = 'ON';   // wrong case, deliberately
    mockRows.push({ key: 'perm_trainer_finance', value: 'false' });

    const res = await request(app('finance', trainer)).get('/thing');
    expect(res.status).toBe(403);
  });
});

describe('the cache cannot outlive a change to the matrix', () => {
  it('a second request inside the TTL does not re-query', async () => {
    mockRows.push({ key: 'perm_trainer_finance', value: 'true' });
    await request(app('finance', trainer)).get('/thing');
    await request(app('finance', trainer)).get('/thing');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('invalidating drops the entry so the next request re-reads', async () => {
    // PUT /api/settings/permissions calls this. Without it an owner switches a
    // toggle, watches nothing happen, and switches it again.
    mockRows.push({ key: 'perm_trainer_finance', value: 'true' });
    await request(app('finance', trainer)).get('/thing');

    invalidatePermissions(ORG);
    mockRows.length = 0;
    mockRows.push({ key: 'perm_trainer_finance', value: 'false' });

    const res = await request(app('finance', trainer)).get('/thing');
    expect(res.status).toBe(403);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

describe('the self-describing read stays reachable', () => {
  // GET /api/settings/permissions is how a client learns its OWN permissions.
  // The frontend's PermissionsProvider calls it for every logged-in user, and
  // perm_trainer_settings ships FALSE — so gating it would 403 the very call
  // that tells a trainer what they may do, the provider would fall back to the
  // shipped defaults, and a studio that granted perm_trainer_finance would have
  // its trainers see no Finance link while the server served them happily. The
  // menu and the API would disagree, which is the failure this whole change
  // exists to end, reintroduced from the other side.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('the /api/settings mount exempts GET /permissions from the settings gate', () => {
    const mount = server.slice(server.indexOf("app.use('/api/settings'"));
    const body = mount.slice(0, mount.indexOf("require('./routes/settings')"));
    expect(body).toMatch(/req\.method === 'GET'/);
    expect(body).toMatch(/req\.path === '\/permissions'/);
  });

  it('and gates everything else on that mount', () => {
    const mount = server.slice(server.indexOf("app.use('/api/settings'"));
    const body = mount.slice(0, mount.indexOf("require('./routes/settings')"));
    expect(body).toMatch(/settingsGate\(req, res, next\)/);
    expect(body).toMatch(/requireStaff/);
  });
});
