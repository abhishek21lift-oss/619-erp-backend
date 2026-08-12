'use strict';
// Recording a PT payment moves the ledger and the balance together.
//
// POST /api/pt-os/payments used to issue two bare pool.query() calls: INSERT
// into pt_payments, then UPDATE pt_clients' paid_amount and balance_amount.
// Each is individually correct — the balance update is relative, so concurrent
// payments cannot lose each other's increments — but nothing tied them
// together.
//
// A failure between them (a constraint, a dropped connection, the 15s
// query_timeout in db/pool.js) left the payment recorded and the balance
// untouched. That is money in the ledger the client's outstanding figure does
// not know about: silent at the time, and surfacing weeks later as a
// reconciliation discrepancy with no trace of where it came from.
//
// This is the live path — src/app/(chrome)/pt-os/clients/[id]/payments in the
// frontend calls it — and /api/payments next door has always done the same two
// writes inside BEGIN … COMMIT with the client row locked. Two endpoints
// writing the same two tables should not disagree about how.
//
// The assertions are about ORDER and PAIRING on a mocked client, because that
// is what broke. Whether the SQL is right is covered by the routes that have
// always run it.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

const ORG = '11111111-1111-1111-1111-111111111111';

// One mock client, so the test can watch the exact statement sequence the
// handler issues on the connection it borrowed.
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'u1', role: 'admin', organization_id: '11111111-1111-1111-1111-111111111111' };
    next();
  },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));

/** Statements issued on the borrowed client, in order, whitespace-collapsed. */
const statements = () =>
  mockClient.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());

const verbs = () => statements().map((s) => s.split(' ')[0].toUpperCase());

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  mockClient.query.mockReset();
  mockClient.release.mockReset();

  // clientInOrg()'s ownership probe runs on the pool before the transaction.
  pool.query.mockResolvedValue({ rows: [{ id: 'c1' }], rowCount: 1 });
  pool.connect.mockResolvedValue(mockClient);
  mockClient.query.mockResolvedValue({ rows: [{ id: 'pay-1' }], rowCount: 1 });
});

const post = (body) => request(app).post('/api/pt-os/payments').send(body);

describe('POST /api/pt-os/payments — the ledger and the balance move together', () => {
  it('wraps the insert and the balance update in one transaction', async () => {
    await post({ client_id: 'c1', amount: 500 }).expect(201);

    const v = verbs();
    expect(v[0]).toBe('BEGIN');
    expect(v[v.length - 1]).toBe('COMMIT');

    const sql = statements();
    const insertAt = sql.findIndex((s) => /INSERT INTO pt_payments/i.test(s));
    const updateAt = sql.findIndex((s) => /UPDATE pt_clients SET/i.test(s));
    expect(insertAt).toBeGreaterThan(0);
    expect(updateAt).toBeGreaterThan(insertAt);
    // Both inside the transaction, not straddling its end.
    expect(updateAt).toBeLessThan(sql.length - 1);
  });

  it('locks the client row before writing, so concurrent payments queue', async () => {
    await post({ client_id: 'c1', amount: 500 }).expect(201);

    const sql = statements();
    const lockAt = sql.findIndex((s) => /FOR UPDATE/i.test(s));
    const insertAt = sql.findIndex((s) => /INSERT INTO pt_payments/i.test(s));
    expect(lockAt).toBeGreaterThan(0);
    expect(lockAt).toBeLessThan(insertAt);
  });

  it('rolls back and writes nothing when the balance update fails', async () => {
    // The exact failure the transaction exists for: the ledger row is already
    // inserted when the second statement dies. Without BEGIN/ROLLBACK that
    // payment stayed, and the balance never moved.
    mockClient.query.mockImplementation((sql) => {
      if (/UPDATE pt_clients SET/i.test(String(sql))) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [{ id: 'pay-1' }], rowCount: 1 });
    });

    await post({ client_id: 'c1', amount: 500 }).expect(500);

    expect(verbs()).toContain('ROLLBACK');
    expect(verbs()).not.toContain('COMMIT');
  });

  it('releases the connection even when the write fails', async () => {
    // A borrowed client that is never released leaks one of the pool's 20
    // connections per failure, which ends as an outage rather than an error.
    mockClient.query.mockRejectedValueOnce(new Error('boom'));
    await post({ client_id: 'c1', amount: 500 });
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('records a payment with no client without locking or updating a balance', async () => {
    // client_id is optional here. `WHERE id = NULL` would match nothing while
    // still costing two round trips, so both statements are skipped.
    await post({ amount: 500 }).expect(201);

    const sql = statements();
    expect(sql.some((s) => /FOR UPDATE/i.test(s))).toBe(false);
    expect(sql.some((s) => /UPDATE pt_clients SET/i.test(s))).toBe(false);
    expect(sql.some((s) => /INSERT INTO pt_payments/i.test(s))).toBe(true);
    expect(verbs()).toContain('COMMIT');
  });

  it('stamps the payment with the caller organization, not anything sent', async () => {
    await post({ client_id: 'c1', amount: 500, organization_id: 'someone-else' }).expect(201);

    const insert = mockClient.query.mock.calls.find(([sql]) =>
      /INSERT INTO pt_payments/i.test(String(sql)));
    expect(insert[1]).toContain(ORG);
    expect(insert[1]).not.toContain('someone-else');
  });
});
