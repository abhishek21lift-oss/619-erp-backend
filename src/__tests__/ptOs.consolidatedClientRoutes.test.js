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
let mockUser = { id: 'u1', role: 'trainer', organization_id: ORG_A };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
  a.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return a;
}

const sqls = () => queries.map((q) => q.sql);
const paramsOf = (re) => (queries.find((q) => re.test(q.sql)) || {}).params;

beforeEach(() => {
  queries.length = 0;
  mockClient = { id: 'ptc-1', trainer_id: 'tr-1' };
  mockUser = { id: 'u1', role: 'trainer', organization_id: ORG_A };
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

  test('the trainer searches the whole studio: no roster narrowing, whatever their profile', async () => {
    // The studio's owner is its trainer. The assistant-coach rule that pinned
    // a trainer to their own roster (and a trainer with no profile to nothing)
    // went with the staff roles; the organization is the whole boundary.
    for (const trainer_id of ['tr-9', null]) {
      queries.length = 0;
      mockUser = { id: 'u2', role: 'trainer', organization_id: ORG_A, trainer_id };
      await request(app()).get('/api/pt-os/clients/search?q=asha');

      const sql = sqls().find((s) => /ILIKE \$1/.test(s));
      expect(sql).not.toMatch(/c\.trainer_id = \$\d/);
      expect(sql).toMatch(/c\.organization_id = \$\d/);
      expect(paramsOf(/ILIKE \$1/)).toContain(ORG_A);
    }
  });

  test('the joined trainer name comes from the same studio only', async () => {
    await request(app()).get('/api/pt-os/clients/search?q=asha');
    const sql = sqls().find((s) => /ILIKE \$1/.test(s));
    expect(sql).toMatch(/LEFT JOIN trainers t ON t\.id = c\.trainer_id AND t\.organization_id = c\.organization_id/);
  });

  test('a member cannot search the studio', async () => {
    mockUser = { id: 'm1', role: 'member', organization_id: ORG_A, pt_client_id: 'ptc-1' };
    const res = await request(app()).get('/api/pt-os/clients/search?q=asha');
    expect([403, 401]).toContain(res.status);
    expect(sqls().some((s) => /ILIKE \$1/.test(s))).toBe(false);
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

  test('the trainer reads any client of their studio, whichever coach profile it names', async () => {
    mockUser = { id: 'u2', role: 'trainer', organization_id: ORG_A, trainer_id: 'tr-OTHER' };
    const res = await request(app()).get('/api/pt-os/clients/ptc-1/payments');
    expect(res.status).toBe(200);
  });

  test('a member is refused and reads no history', async () => {
    mockUser = { id: 'm1', role: 'member', organization_id: ORG_A, pt_client_id: 'ptc-1' };
    const res = await request(app()).get('/api/pt-os/clients/ptc-1/payments');
    expect([403, 401]).toContain(res.status);
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

  test('DELETE /clients/:id refuses a member', async () => {
    mockUser = { id: 'u5', role: 'member', organization_id: ORG_A, pt_client_id: 'ptc-1' };
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
