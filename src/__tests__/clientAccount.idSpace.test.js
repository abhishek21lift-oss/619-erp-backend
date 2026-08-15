'use strict';
// A client account must reach its OWN records, and only its own.
//
// `users` carries two different client links, and they are not
// interchangeable:
//
//   users.pt_client_id → pt_clients   (the live model, migration 154)
//   users.member_id    → clients      (legacy v3, 0 rows in production)
//
// Client-portal accounts have role 'member' with pt_client_id set and
// member_id NULL — verified against production, where the single live client
// account looks exactly like that and no user anywhere has a member_id.
//
// Several routes clamped a member to "their own" data using member_id while
// querying a table keyed by pt_clients. Because member_id is NULL on every
// real account, the comparison could only ever fail: the routes did not leak,
// they locked the client out of their own payments, their own UPI history and
// their own client record, and silently dropped every payment notification.
// That is a failure mode nobody reports as a security bug and everybody
// reports as "the app is broken".
//
// These tests pin both halves — the client reaches their own row, and cannot
// reach another client's — so a future edit cannot quietly swap the columns
// back.

const queries = [];
let mockQueryImpl = async (sql, params) => {
  queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  return { rows: [], rowCount: 0 };
};
jest.mock('../db/pool', () => ({
  query: jest.fn((...args) => mockQueryImpl(...args)),
  connect: jest.fn(),
}));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));

const ORG = '11111111-1111-1111-1111-111111111111';
const MY_CLIENT = 'ptc-mine';
const OTHER_CLIENT = 'ptc-theirs';

// A real client account: role 'member', pt_client_id set, member_id NULL.
const CLIENT_USER = {
  id: 'usr-client', role: 'member', organization_id: ORG,
  pt_client_id: MY_CLIENT, member_id: null,
};

let mockUser = CLIENT_USER;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const express = require('express');
const request = require('supertest');

function app(mountPath, routerPath) {
  const a = express();
  a.use(express.json());
  // The payments router reads req.branchScope, which branch-scope middleware
  // normally attaches after auth. A client account has no branch_id, so the
  // real middleware would produce the same no-op filter this does.
  a.use((req, _res, next) => {
    req.branchScope = { isAdmin: false, branchId: null, appendTo: (p) => ({ sql: 'TRUE', params: p || [] }) };
    next();
  });
  a.use(mountPath, require(routerPath));
  return a;
}

beforeEach(() => {
  queries.length = 0;
  mockUser = { ...CLIENT_USER };
  mockQueryImpl = async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  };
});

describe('GET /api/payments — a client sees their own payments', () => {
  test('clamps on the pt_clients link, not the legacy one', async () => {
    await request(app('/api/payments', '../routes/payments')).get('/api/payments');

    const q = queries.find((x) => /FROM pt_payments p/i.test(x.sql));
    expect(q).toBeTruthy();
    // The clamp covers both ledgers in the UNION, and the live one is first.
    expect(q.sql).toMatch(/p\.client_id = ANY\(\$\d\)/);
    const arr = q.params.find((p) => Array.isArray(p));
    expect(arr).toContain(MY_CLIENT);
  });

  test('an account linked to neither id matches nothing rather than everything', async () => {
    mockUser = { ...CLIENT_USER, pt_client_id: null, member_id: null };
    await request(app('/api/payments', '../routes/payments')).get('/api/payments');

    const q = queries.find((x) => /FROM pt_payments p/i.test(x.sql));
    const arr = q.params.find((p) => Array.isArray(p));
    // An empty array in `= ANY(...)` matches no row. Fail closed.
    expect(arr).toEqual([]);
  });

  test('a client cannot widen the clamp by passing client_id', async () => {
    await request(app('/api/payments', '../routes/payments'))
      .get(`/api/payments?client_id=${OTHER_CLIENT}`);

    const q = queries.find((x) => /FROM pt_payments p/i.test(x.sql));
    const arr = q.params.find((p) => Array.isArray(p));
    expect(arr).toEqual([MY_CLIENT]);
    expect(q.params).not.toContain(OTHER_CLIENT);
  });
});

describe('GET /api/clients/:id — a client sees their own record', () => {
  test('their own id is allowed through', async () => {
    mockQueryImpl = async (sql, params) => {
      const clean = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: clean, params });
      if (/FROM pt_clients c/i.test(clean)) {
        return { rows: [{ id: MY_CLIENT, name: 'Mine', trainer_id: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const res = await request(app('/api/clients', '../routes/clients')).get(`/api/clients/${MY_CLIENT}`);
    expect(res.status).not.toBe(404);
  });

  test("another client's record is refused", async () => {
    mockQueryImpl = async (sql, params) => {
      const clean = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: clean, params });
      if (/FROM pt_clients c/i.test(clean)) {
        return { rows: [{ id: OTHER_CLIENT, name: 'Theirs', trainer_id: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const res = await request(app('/api/clients', '../routes/clients')).get(`/api/clients/${OTHER_CLIENT}`);
    expect(res.status).toBe(404);
  });
});

describe('requireSelfOrRole admits a real client account', () => {
  const { requireSelfOrRole } = require('../middleware/rbac');

  function run(user, id) {
    const req = { user, params: { id } };
    let status = null;
    const res = { status: (c) => { status = c; return { json: () => {} }; } };
    let passed = false;
    requireSelfOrRole('admin')(req, res, () => { passed = true; });
    return { passed, status };
  }

  test('matches on pt_client_id, which is what a real client actually has', () => {
    expect(run(CLIENT_USER, MY_CLIENT).passed).toBe(true);
  });

  test("does not match another client's id", () => {
    const r = run(CLIENT_USER, OTHER_CLIENT);
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });

  test('a NULL link never matches', () => {
    const r = run({ ...CLIENT_USER, pt_client_id: null, member_id: null }, MY_CLIENT);
    expect(r.passed).toBe(false);
  });

  test('an elevated role still passes without an id match', () => {
    expect(run({ id: 'a', role: 'admin' }, OTHER_CLIENT).passed).toBe(true);
  });
});

describe('the UPI routes address the pt_clients id space', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'upi-payments.js'), 'utf8'
  );

  // Asserted on the source because these sites sit behind org resolution and
  // request validation that a unit test would have to reconstruct wholesale;
  // what matters is which column each one reads, and that is visible here.
  test('no executable line clamps a member on member_id any more', () => {
    const offenders = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .filter((line) => /req\.user\.member_id/.test(line));
    expect(offenders).toEqual([]);
  });

  test('the client-account lookup joins on pt_client_id', () => {
    expect(src).toMatch(/SELECT id FROM users WHERE pt_client_id = \$1/);
    expect(src).not.toMatch(/SELECT id FROM users WHERE member_id = \$1/);
  });

  test('all three member clamps read pt_client_id', () => {
    // loadOrderForCaller, resolveTargetClient, and the /history handler.
    expect((src.match(/req\.user\.pt_client_id/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});
