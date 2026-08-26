'use strict';
// TRAINER_LIMIT and OWNER_EXISTS — the API half of one studio, one owner, one
// trainer.
//
// Migration 184 enforces the trainer rule in the database and refuses to be
// skipped — if trainers_one_active_per_org cannot be built, the migration
// aborts the deploy. So these guards are not what enforces the rule, and the
// gap between their check and their insert does not matter: losing that race
// means the index rejects the second write.
//
// What they do is turn the refusal into something actionable. Without them a
// second trainer is a 500 naming a constraint; with them it is a 409 naming
// the trainer who already holds the slot, which is what the Add Coach screen
// renders.
//
// There is no database constraint for the owner rule at all — a partial unique
// index on admins would fail to build wherever two already exist, and demoting
// one silently changes a real person's access. So for owners these routes are
// the only enforcement, which is the argument for testing all of them rather
// than a representative one.
//
// Asserted on status and code rather than on prose: the message is written for
// a human and will be reworded, the contract is the 409 and the code.

const mockQueries = [];
let mockRows = {};

/** Answers each guard's lookup with whatever the test set up, and records
 *  every statement so "did it even check?" is answerable. */
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: flat, params });
    if (/FROM trainers\b/i.test(flat) && /status = 'active'/i.test(flat)) {
      return { rows: mockRows.trainer ? [mockRows.trainer] : [], rowCount: mockRows.trainer ? 1 : 0 };
    }
    if (/FROM users\b/i.test(flat) && /role = 'admin'/i.test(flat) && /is_active = true/i.test(flat)) {
      return { rows: mockRows.owner ? [mockRows.owner] : [], rowCount: mockRows.owner ? 1 : 0 };
    }
    // Email-uniqueness probes and the organization existence check.
    if (/SELECT 1 FROM users/i.test(flat) || /LOWER\(email\)/i.test(flat)) return { rows: [], rowCount: 0 };
    if (/FROM organizations/i.test(flat)) return { rows: [{ id: params && params[0] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const ORG = '11111111-1111-1111-1111-111111111111';
let mockUser = { id: 'u1', role: 'admin', organization_id: ORG };

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
  invalidateUserCache: jest.fn(),
}));
jest.mock('../middleware/tenant', () => ({
  requireSuperAdmin: (_req, _res, next) => next(),
  requireOrgScope: (_req, _res, next) => next(),
}));
jest.mock('../middleware/validate', () => ({ validate: () => (_req, _res, next) => next() }));

// routes/auth.js requires otplib, whose CJS build pulls in the ESM-only
// @scure/base. Node resolves that; Jest's resolver does not, and the suite
// failed to parse before running an assertion. Nothing here touches TOTP —
// otplib.contract.test.js exercises the real module under plain Node.
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'JBSWY3DPEHPK3PXP'),
  verifySync: jest.fn(() => ({ valid: false })),
}));

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.DATABASE_URL = 'postgres://test';
process.env.FRONTEND_URL = 'https://test.example.com';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

const EXISTING_TRAINER = { id: 'tr-1', name: 'Asha', email: 'asha@studio.test' };
const EXISTING_OWNER = { id: 'u-own', name: 'Deepak', email: 'deepak@studio.test' };

function mount(path, mod) {
  const a = express();
  a.use(express.json());
  a.use(path, require(mod));
  return a;
}

beforeEach(() => {
  mockQueries.length = 0;
  mockRows = {};
  mockUser = { id: 'u1', role: 'admin', organization_id: ORG };
});

describe('TRAINER_LIMIT — a studio has one trainer', () => {
  const cases = [
    ['POST /api/trainers', '/api/trainers', '../routes/trainers', '/',
      { name: 'Second Coach' }, (b) => b.code],
    ['POST /pt-os/trainers', '/api/pt-os', '../modules/pt-os/pt-os.routes', '/trainers',
      { name: 'Second Coach' }, (b) => b.error.code],
  ];

  test.each(cases)('%s refuses a second active trainer', async (_label, base, mod, route, body, codeOf) => {
    mockRows.trainer = EXISTING_TRAINER;
    const res = await request(mount(base, mod)).post(base + route).send(body);

    expect(res.status).toBe(409);
    expect(codeOf(res.body)).toBe('TRAINER_LIMIT');
    // The refusal has to happen instead of the insert, not alongside it.
    expect(mockQueries.some((q) => /INSERT INTO trainers/i.test(q.sql))).toBe(false);
  });

  test.each(cases)('%s creates the first trainer normally', async (_label, base, mod, route, body) => {
    mockRows.trainer = null;
    const res = await request(mount(base, mod)).post(base + route).send(body);

    expect(res.status).not.toBe(409);
    expect(mockQueries.some((q) => /INSERT INTO trainers/i.test(q.sql))).toBe(true);
  });

  test.each(cases)('%s scopes the check to the caller studio', async (_label, base, mod, route, body) => {
    // A global check would refuse every studio but the first one on the
    // platform — the same class of bug the tenant-isolation suite exists for.
    mockRows.trainer = null;
    await request(mount(base, mod)).post(base + route).send(body);

    const check = mockQueries.find((q) => /FROM trainers/i.test(q.sql) && /status = 'active'/i.test(q.sql));
    expect(check).toBeDefined();
    expect(check.sql).toMatch(/organization_id = \$1/);
    expect(check.params).toEqual([ORG]);
  });

  test('an archived trainer frees the slot', async () => {
    // status='inactive' is how a trainer is retired; the row and all its
    // commission history stay. If archiving did not free the slot, a studio
    // that changed coach could never add the new one.
    mockRows.trainer = null; // the guard's query already filters status='active'
    const res = await request(mount('/api/trainers', '../routes/trainers'))
      .post('/api/trainers/').send({ name: 'Replacement' });

    expect(res.status).not.toBe(409);
  });

  test('editing the existing trainer is untouched by the guard', async () => {
    mockRows.trainer = EXISTING_TRAINER;
    const res = await request(mount('/api/trainers', '../routes/trainers'))
      .put('/api/trainers/tr-1').send({ name: 'Asha Renamed' });

    expect(res.status).not.toBe(409);
  });
});

describe('OWNER_EXISTS — a studio has one owner', () => {
  test('POST /api/auth/create-user refuses a second admin', async () => {
    mockRows.owner = EXISTING_OWNER;
    const res = await request(mount('/api/auth', '../routes/auth'))
      .post('/api/auth/create-user')
      .send({ name: 'Second Owner', email: 'two@studio.test', password: 'longenough1', role: 'admin' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OWNER_EXISTS');
    expect(mockQueries.some((q) => /INSERT INTO users/i.test(q.sql))).toBe(false);
  });

  test.each(['manager', 'reception', 'trainer', 'member'])(
    'POST /api/auth/create-user still allows a %s', async (role) => {
      // manager and reception stay legal — the decision was to stop creating
      // them by default, not to remove them. A guard that blocked every role
      // would lock studios out of their own staff.
      mockRows.owner = EXISTING_OWNER;
      const res = await request(mount('/api/auth', '../routes/auth'))
        .post('/api/auth/create-user')
        .send({ name: 'Staff', email: `${role}@studio.test`, password: 'longenough1', role });

      expect(res.status).not.toBe(409);
    });

  test('POST /api/auth/create-user creates the first admin normally', async () => {
    mockRows.owner = null;
    const res = await request(mount('/api/auth', '../routes/auth'))
      .post('/api/auth/create-user')
      .send({ name: 'First Owner', email: 'one@studio.test', password: 'longenough1', role: 'admin' });

    expect(res.status).not.toBe(409);
  });

  test('the platform console refuses a second admin for the studio in the URL', async () => {
    // Not the caller's own org: the console creates users into a studio it does
    // not belong to, so a guard reading the caller's org would check the wrong
    // studio and let every duplicate through.
    mockRows.owner = EXISTING_OWNER;
    const res = await request(mount('/api/platform', '../modules/platform/super-admin/organizations'))
      .post(`/api/platform/organizations/${ORG}/users`)
      .send({ name: 'Second Owner', email: 'two@studio.test', password: 'longenough1', role: 'admin' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OWNER_EXISTS');

    const check = mockQueries.find((q) => /FROM users/i.test(q.sql) && /role = 'admin'/i.test(q.sql));
    expect(check.params).toEqual([ORG]);
  });

  test('an admin that is deactivated does not block a replacement', async () => {
    // The guard counts is_active = true AND deleted_at IS NULL, matching how
    // LAST_ADMIN counts (super-admin/organizations.js:327-331). A looser
    // definition would let a disabled account lock a studio out of ever having
    // a working owner.
    mockRows.owner = null;
    const res = await request(mount('/api/auth', '../routes/auth'))
      .post('/api/auth/create-user')
      .send({ name: 'Replacement', email: 'new@studio.test', password: 'longenough1', role: 'admin' });

    expect(res.status).not.toBe(409);
    const check = mockQueries.find((q) => /FROM users/i.test(q.sql) && /role = 'admin'/i.test(q.sql));
    expect(check.sql).toMatch(/is_active = true/);
    expect(check.sql).toMatch(/deleted_at IS NULL/);
  });
});
