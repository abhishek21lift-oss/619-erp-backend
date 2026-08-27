// /api/settings is bounded by the caller's studio.
//
// ── What this file exists to stop coming back ───────────────────────────────
//
// `system_settings` and `feature_flags` had no organization_id column until
// migration 180, so not one of the fourteen queries in routes/settings.js was
// scoped — there was nothing to scope them by. The write routes are gated on
// `adminOnly`, which is role === 'admin': the ordinary Studio Owner role that
// every self-serve trial signup is granted, NOT the platform operator.
//
// So a trial account could:
//
//   PUT    /api/settings/gym          → rewrite every studio's name, address,
//                                       GST number, currency and geofence
//   PUT    /api/settings/permissions  → rewrite the sixteen-key role matrix
//                                       for every studio on the platform
//   PUT    /api/settings/feature-flags→ flip a flag for everyone
//   DELETE /api/settings/branches/:id → delete another studio's branch
//   GET    /api/settings/studio       → read every studio's branch names,
//                                       locations and client counts
//
// tenantColumns.convention.test.js listed both tables under KNOWN_GAPS with the
// note "per-studio keys (branch_N) inside a shared table". That is true of
// `branch_%` keys and false of GYM_KEYS, PERM_KEYS and feature_flags, which are
// fixed global names with one row each for the whole platform. And
// memberEscalation.authz.test.js, which drives a hostile session at 25 mounts,
// never covered /api/settings — so nothing failed.
//
// The assertions below are deliberately about the SQL rather than about a
// response body: the bug was never a wrong answer, it was a missing predicate.
'use strict';

const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockUser = { id: 'admin-1', role: 'admin', organization_id: 'org-A' };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (req, res, next) => (
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/settings', require('../routes/settings'));
  return a;
}

/** Statements that touch a tenant-owned table. */
const tenantQueries = () =>
  mockQueries.filter((q) => /system_settings|feature_flags|pt_clients/i.test(q.sql));

const ORG_PREDICATE = /organization_id\s*(=\s*\$\d|\))/i;

beforeEach(() => {
  mockQueries.length = 0;
  mockUser = { id: 'admin-1', role: 'admin', organization_id: 'org-A' };
});

// Every route on this router, with the request that exercises it. Driven as a
// table so a route added later without a case here is visible as an omission
// rather than silently uncovered — which is how the original gap survived.
const ROUTES = [
  ['GET',    '/api/settings',                    undefined],
  ['GET',    '/api/settings/studio',             undefined],
  ['GET',    '/api/settings/branches',           undefined],
  ['GET',    '/api/settings/gym',                undefined],
  ['GET',    '/api/settings/permissions',        undefined],
  ['GET',    '/api/settings/feature-flags',      undefined],
  ['PUT',    '/api/settings',                    { gym_name: 'Studio A' }],
  ['PUT',    '/api/settings/gym',                { geofence_radius: 250 }],
  ['PUT',    '/api/settings/permissions',        { perm_trainer_finance: true }],
  ['PUT',    '/api/settings/feature-flags',      { face_checkin: false }],
  ['POST',   '/api/settings/branches',           { name: 'Andheri' }],
];

describe('every settings query names the caller\'s organisation', () => {
  it.each(ROUTES)('%s %s', async (method, url, body) => {
    const req = request(app())[method.toLowerCase()](url);
    if (body) req.send(body);
    await req;

    const touched = tenantQueries();
    expect(touched.length).toBeGreaterThan(0);
    for (const q of touched) {
      expect(q.sql).toMatch(ORG_PREDICATE);
      expect(q.params).toContain('org-A');
    }
  });
});

describe('the reads that used to span the platform', () => {
  it('GET /studio scopes the branch list AND the client count inside it', async () => {
    // Two separate boundaries in one statement. The outer filter bounds
    // system_settings; the correlated subquery counts pt_clients and is not
    // reached by it, so unscoped it aggregated every studio's clients that
    // happened to share a branch key.
    await request(app()).get('/api/settings/studio');

    const branchQuery = mockQueries.find((q) => /LIKE 'branch_%'/i.test(q.sql));
    expect(branchQuery).toBeDefined();
    expect(branchQuery.sql).toMatch(/s\.organization_id\s*=\s*\$\d/i);
    expect(branchQuery.sql).toMatch(/c\.organization_id\s*=\s*\$\d/i);
  });

  it('GET /gym reads this studio\'s keys, not whichever studio wrote last', async () => {
    await request(app()).get('/api/settings/gym');

    const q = mockQueries.find((x) => /FROM system_settings/i.test(x.sql));
    expect(q.sql).toMatch(ORG_PREDICATE);
    expect(q.params).toContain('org-A');
  });
});

describe('the writes that used to address every studio', () => {
  it('upserts settings against (organization_id, key), not key alone', async () => {
    // ON CONFLICT (key) was the platform-wide shape: the second studio to set
    // gym_name overwrote the first. Migration 180 replaced the primary key
    // with a per-studio unique index, and this is the statement that targets it.
    await request(app()).put('/api/settings').send({ gym_name: 'Studio A' });

    const write = mockQueries.find((q) => /INSERT INTO system_settings/i.test(q.sql));
    expect(write.sql).toMatch(/ON CONFLICT \(\s*organization_id,\s*key\s*\)/i);
    expect(write.params).toContain('org-A');
  });

  it('scopes the feature-flag UPDATE', async () => {
    await request(app()).put('/api/settings/feature-flags').send({ face_checkin: false });

    const write = mockQueries.find((q) => /UPDATE feature_flags/i.test(q.sql));
    expect(write.sql).toMatch(/f\.organization_id\s*=\s*\$\d/i);
    expect(write.params).toContain('org-A');
  });

  it('a branch write cannot reach another studio\'s row', async () => {
    await request(app())
      .put('/api/settings/branches/0b4d1f2e-1111-2222-3333-444455556666')
      .send({ name: 'Renamed' });

    for (const q of tenantQueries()) {
      expect(q.sql).toMatch(ORG_PREDICATE);
      expect(q.params).toContain('org-A');
    }
  });
});

describe('a write with no organisation is refused, never widened', () => {
  // orgWhere() returns an empty string when no organisation resolved. That is
  // correct for a read — the operator console reads across studios — and
  // catastrophic for a write: an UPDATE with no predicate rewrites every
  // studio's row, and an INSERT with a NULL organization_id recreates exactly
  // the platform-global row migration 180 removed.
  const WRITES = [
    ['PUT',  '/api/settings',               { gym_name: 'x' }],
    ['PUT',  '/api/settings/gym',           { geofence_radius: 1 }],
    ['PUT',  '/api/settings/permissions',   { perm_trainer_finance: true }],
    ['PUT',  '/api/settings/feature-flags', { face_checkin: false }],
    ['POST', '/api/settings/branches',      { name: 'Andheri' }],
  ];

  it.each(WRITES)('%s %s answers 400 and writes nothing', async (method, url, body) => {
    mockUser = { id: 'admin-2', role: 'admin', organization_id: null };

    const res = await request(app())[method.toLowerCase()](url).send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_TARGET_ORG');
    const writes = mockQueries.filter((q) =>
      /INSERT INTO|UPDATE |DELETE FROM/i.test(q.sql));
    expect(writes).toHaveLength(0);
  });
});
