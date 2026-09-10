'use strict';
// The client API after /api/clients was retired.
//
// ── What this file is replacing, and why it is not a port ───────────────────
//
// /api/clients and /api/pt-os/clients were two HTTP surfaces over one table.
// Both read pt_clients; the legacy `clients` table they were named after was
// dropped by migration 170. Four of the old mount's seven endpoints duplicated
// a pt-os handler outright; three did not, and those moved here.
//
// Two suites used to guard the old mount — clients.remainingRoutesUsePtClients
// and clients.updateUsesPtClients. Their subject is deleted, so they are gone
// too, but the PROPERTIES they pinned are not optional and are re-proved below
// against the handlers that survived. Specifically:
//
//   · a delete is org-scoped, so one studio cannot destroy another's client
//     by id — the single most dangerous thing in the old file, since
//     repointing an unscoped `WHERE id=$1` delete at pt_clients would have
//     been strictly worse than the 404 it replaced;
//   · an edit is org-scoped and partial, so saving one field does not blank
//     the others;
//   · the client history endpoints resolve the client org-scoped BEFORE
//     reading anything.
//
// And the property the old /search endpoint carried, which is the one most
// easily lost in a move: a trainer sees only their own roster, and a trainer
// with no linked trainer record sees NOTHING rather than everything.

const queries = [];
let mockClient = { id: 'ptc-1', trainer_id: 'tr-1' };

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: text, params });
    if (/SELECT id, trainer_id FROM pt_clients/i.test(text)) {
      return { rows: mockClient ? [mockClient] : [], rowCount: mockClient ? 1 : 0 };
    }
    if (/FROM attendance_logs/i.test(text)) return { rows: [{ id: 'a1' }], rowCount: 1 };
    if (/FROM pt_payments/i.test(text)) return { rows: [{ id: 'p1' }], rowCount: 1 };
    if (/FROM \(SELECT pc\.\* .* FROM pt_clients pc\) c/i.test(text)) {
      return { rows: [{ id: 'ptc-1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORG_A = '11111111-1111-1111-1111-111111111111';
let mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' })),
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
  // branchScope is applied globally at /api/ in server.js, so a pt-os handler
  // can rely on it. A user with no branch gets the permissive 'TRUE'.
  a.use((req, _res, next) => {
    req.branchScope = { appendTo: (p) => ({ sql: 'TRUE', params: p || [] }) };
    next();
  });
  a.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
  a.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return a;
}

const sqls = () => queries.map((q) => q.sql);
const paramsOf = (re) => (queries.find((q) => re.test(q.sql)) || {}).params;

beforeEach(() => {
  queries.length = 0;
  mockClient = { id: 'ptc-1', trainer_id: 'tr-1' };
  mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
});

describe('GET /clients/search', () => {
  test('an empty query returns nothing without touching the database', async () => {
    const res = await request(app()).get('/api/pt-os/clients/search?q=');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(sqls().some((s) => /pt_clients/i.test(s))).toBe(false);
  });

  test('search is routed before /clients/:id', async () => {
    // Express matches in declaration order, so a /clients/:id declared first
    // would swallow "search" as an id. /duplicates and /birthdays carry the
    // same constraint and the same comment.
    const res = await request(app()).get('/api/pt-os/clients/search?q=asha');
    expect(res.status).toBe(200);
    expect(sqls().some((s) => /ILIKE \$1/.test(s))).toBe(true);
  });

  test('the caller organization is bound into the query', async () => {
    await request(app()).get('/api/pt-os/clients/search?q=asha');
    const params = paramsOf(/ILIKE \$1/);
    expect(params).toContain(ORG_A);
    expect(sqls().find((s) => /ILIKE \$1/.test(s))).toMatch(/c\.organization_id = \$\d/);
  });

  test('a trainer is restricted to their own roster', async () => {
    mockUser = { id: 'u2', role: 'trainer', organization_id: ORG_A, trainer_id: 'tr-9' };
    await request(app()).get('/api/pt-os/clients/search?q=asha');

    const sql = sqls().find((s) => /ILIKE \$1/.test(s));
    expect(sql).toMatch(/c\.trainer_id = \$\d/);
    expect(paramsOf(/ILIKE \$1/)).toContain('tr-9');
  });

  test('a trainer with NO linked record matches nothing, not everything', async () => {
    // The fail-closed rule, and the one this move could most easily have lost:
    // treating a null trainer_id as "no filter" hands that account the whole
    // studio's roster. The filter must still be applied, bound to NULL, so
    // `trainer_id = NULL` is never true.
    mockUser = { id: 'u3', role: 'trainer', organization_id: ORG_A, trainer_id: null };
    await request(app()).get('/api/pt-os/clients/search?q=asha');

    const sql = sqls().find((s) => /ILIKE \$1/.test(s));
    expect(sql).toMatch(/c\.trainer_id = \$\d/);
    expect(paramsOf(/ILIKE \$1/)).toContain(null);
  });

  test('a non-trainer is not roster-filtered at all', async () => {
    // The other half — an admin must not be silently restricted to nothing.
    await request(app()).get('/api/pt-os/clients/search?q=asha');
    expect(sqls().find((s) => /ILIKE \$1/.test(s))).not.toMatch(/c\.trainer_id = \$\d/);
  });

  test('the branch predicate is still applied against the synthesised column', async () => {
    // pt_clients has no branch_id, so the subselect synthesises a NULL one.
    // For a user WITH a branch that predicate matches nothing, which is what
    // branch-scope means by "legacy rows with a NULL branch are not visible".
    // Dropping the shim would turn "sees nothing" into "sees everything".
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.branchScope = { appendTo: (p) => ({ sql: 'branch_id = $' + (p.length + 1), params: [...p, 'br-1'] }) };
      next();
    });
    a.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));

    await request(a).get('/api/pt-os/clients/search?q=asha');
    const sql = sqls().find((s) => /ILIKE \$1/.test(s));
    expect(sql).toMatch(/NULL::text AS branch_id/);
    expect(sql).toMatch(/c\.branch_id = \$\d/);
    expect(paramsOf(/ILIKE \$1/)).toContain('br-1');
  });

  test('the page size is capped', async () => {
    await request(app()).get('/api/pt-os/clients/search?q=asha&limit=99999');
    expect(paramsOf(/ILIKE \$1/)).toContain(100);
  });
});

describe('GET /clients/:id/attendance and /payments', () => {
  test('the client is resolved org-scoped BEFORE any history is read', async () => {
    await request(app()).get('/api/pt-os/clients/ptc-1/attendance');

    const lookup = sqls().find((s) => /SELECT id, trainer_id FROM pt_clients/i.test(s));
    expect(lookup).toMatch(/organization_id = \$\d/);
    expect(paramsOf(/SELECT id, trainer_id FROM pt_clients/i)).toContain(ORG_A);
    // Order matters: the guard has to precede the read it is guarding.
    expect(sqls().findIndex((s) => /SELECT id, trainer_id FROM pt_clients/i.test(s)))
      .toBeLessThan(sqls().findIndex((s) => /FROM attendance_logs/i.test(s)));
  });

  test("another studio's client is a 404 and reads no history", async () => {
    // The org-scoped lookup returns nothing, which is the same answer as "no
    // such client" on purpose — a 403 would confirm the id is real.
    mockClient = null;
    const res = await request(app()).get('/api/pt-os/clients/ptc-1/attendance');

    expect(res.status).toBe(404);
    expect(sqls().some((s) => /FROM attendance_logs/i.test(s))).toBe(false);
  });

  test('a trainer cannot read another trainer\'s client', async () => {
    mockUser = { id: 'u2', role: 'trainer', organization_id: ORG_A, trainer_id: 'tr-OTHER' };
    const res = await request(app()).get('/api/pt-os/clients/ptc-1/payments');

    expect(res.status).toBe(403);
    expect(sqls().some((s) => /FROM pt_payments/i.test(s))).toBe(false);
  });

  test('a trainer with no linked record is refused, not allowed through', async () => {
    mockUser = { id: 'u3', role: 'trainer', organization_id: ORG_A, trainer_id: null };
    const res = await request(app()).get('/api/pt-os/clients/ptc-1/payments');
    expect(res.status).toBe(403);
  });

  test('...including for a client who has no trainer either', async () => {
    // The case the `!req.user.trainer_id` half of the guard exists for, and the
    // one a fixture with an assigned client cannot reach: drop that half and
    // the check becomes `null !== null`, which is false, so an unassigned
    // client becomes readable by any trainer account with no linked record.
    // Found by mutation — the previous test passed with the guard removed.
    mockClient = { id: 'ptc-2', trainer_id: null };
    mockUser = { id: 'u3', role: 'trainer', organization_id: ORG_A, trainer_id: null };

    const res = await request(app()).get('/api/pt-os/clients/ptc-2/payments');

    expect(res.status).toBe(403);
    expect(sqls().some((s) => /FROM pt_payments/i.test(s))).toBe(false);
  });

  test('the owning trainer is allowed', async () => {
    mockUser = { id: 'u4', role: 'trainer', organization_id: ORG_A, trainer_id: 'tr-1' };
    const res = await request(app()).get('/api/pt-os/clients/ptc-1/attendance');
    expect(res.status).toBe(200);
  });

  test('payments come from pt_payments with the aliases the profile page renders', async () => {
    // Not `payments` — that is the gym-era ledger. The aliases are part of the
    // contract the old endpoint had, and the page reads these keys.
    await request(app()).get('/api/pt-os/clients/ptc-1/payments');
    const sql = sqls().find((s) => /FROM pt_payments/i.test(s));
    expect(sql).toMatch(/payment_method AS method/);
    expect(sql).toMatch(/payment_ref AS receipt_no/);
    expect(sql).toMatch(/deleted_at IS NULL/);
  });

  test('neither endpoint queries the dropped legacy table', async () => {
    await request(app()).get('/api/pt-os/clients/ptc-1/attendance');
    await request(app()).get('/api/pt-os/clients/ptc-1/payments');
    for (const s of sqls()) expect(s).not.toMatch(/\b(FROM|UPDATE|INTO|JOIN) clients\b/i);
  });
});

describe('the endpoints the retired mount duplicated', () => {
  test('DELETE /clients/:id is org-scoped — one studio cannot delete another\'s client', async () => {
    // Re-proved from clients.remainingRoutesUsePtClients. An unscoped
    // `WHERE id=$1` delete against pt_clients is a cross-tenant destroy.
    await request(app()).delete('/api/pt-os/clients/ptc-1');
    const del = sqls().find((s) => /pt_clients/i.test(s) && /(DELETE FROM|deleted_at)/i.test(s));
    expect(del).toBeDefined();
    expect(del).toMatch(/organization_id/);
  });

  test('DELETE /clients/:id refuses a non-admin', async () => {
    mockUser = { id: 'u5', role: 'trainer', organization_id: ORG_A, trainer_id: 'tr-1' };
    const res = await request(app()).delete('/api/pt-os/clients/ptc-1');
    expect(res.status).toBe(403);
  });

  test('PATCH /clients/:id is org-scoped', async () => {
    // Re-proved from clients.updateUsesPtClients: `WHERE id=$1` with no org on
    // a table holding every studio's clients is a cross-tenant write.
    await request(app()).patch('/api/pt-os/clients/ptc-1').send({ notes: 'hello' });
    const upd = sqls().find((s) => /^UPDATE pt_clients/i.test(s));
    expect(upd).toBeDefined();
    expect(upd).toMatch(/organization_id/);
  });

  test('PATCH only writes the fields it was sent', async () => {
    // The blanking bug: a full-row UPDATE fed by a partial body wrote NULL
    // over every column the form did not include, so saving a note erased the
    // client's phone, email, dates and weight.
    await request(app()).patch('/api/pt-os/clients/ptc-1').send({ notes: 'hello' });
    const upd = sqls().find((s) => /^UPDATE pt_clients/i.test(s));
    expect(upd).toMatch(/notes/);
    expect(upd).not.toMatch(/mobile/);
    expect(upd).not.toMatch(/email/);
  });
});
