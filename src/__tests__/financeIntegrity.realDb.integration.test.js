'use strict';
// Finance records, against a real migrated database (Phase 3).
//
// Two confirmed gaps, pinned here:
//
//   1. Invoices, expenses and plans wrote no activity_log row at all. Every
//      other path that moves money (lib/ptPayments, UPI, /api/payments) is
//      audited; these three let a studio's invoices be marked paid or
//      cancelled, its expenses edited or deleted, and its prices changed, with
//      no record of who did it.
//
//   2. POST /api/invoices stored whatever `status` it was sent. PUT already
//      refuses `paid` — "only mark-paid records money" — but create did not, so
//      an invoice could be born `paid` with no payment row and no balance
//      change. Its structured items[] path also still parsed with
//      `parseFloat(x) || 0`, so a negative or garbage price or tax went through.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Finance integrity, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the finance integrity proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../modules/automation/automation.triggers', () => new Proxy({}, { get: () => async () => {} }));

const ORG = 'f1a70000-0000-4000-8000-000000000601';
const OTHER_ORG = 'f1a70000-0000-4000-8000-000000000602';
const USER = 'fin-integrity-user';
let mockOrg = ORG;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'fin-integrity-user', name: 'Fin', role: 'trainer', organization_id: mockOrg }; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

describeIf('Finance integrity, against a real database', () => {
  let pool;
  let request;
  let clientId;

  beforeAll(async () => {
    pool = require('../db/pool');
    for (const [id, slug] of [[ORG, 'fin-studio'], [OTHER_ORG, 'fin-other']]) {
      await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`, [id, slug]);
    }
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'Fin', 'fin@test.invalid', '!x', 'trainer', $2, TRUE) ON CONFLICT (id) DO NOTHING`, [USER, ORG]);
    const { rows: [c] } = await pool.query(
      `INSERT INTO pt_clients (name, mobile, organization_id, status) VALUES ('Fin Client', '9876501234', $1, 'active') RETURNING id`, [ORG]);
    clientId = c.id;

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/invoices', require('../routes/invoices'));
    app.use('/api/expenses', require('../routes/expenses'));
    app.use('/api/plans', require('../routes/plans'));
    app.use(require('../middleware/errorHandler').errorHandler);
    request = () => require('supertest')(app);
  });

  beforeEach(() => { mockOrg = ORG; });

  afterAll(async () => {
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_payments WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = $1)', [ORG]);
    await pool.query('DELETE FROM invoices WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM expenses WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM plans WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM pt_clients WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG, OTHER_ORG]]);
    await pool.end();
  });

  const audit = async (action, entityId) => (await pool.query(
    `SELECT action, entity_id, organization_id, user_id FROM activity_log
      WHERE user_id = $1 AND action = $2 AND entity_id = $3`, [USER, action, String(entityId)])).rows;

  const newInvoice = async (body = { member_name: 'Walk-in', amount: 1500, description: 'PT' }) => {
    const res = await request().post('/api/invoices').send(body);
    expect(res.status).toBe(201);
    return res.body.invoice;
  };

  describe('an invoice cannot be created already paid', () => {
    it.each(['paid', 'partial', 'cancelled'])('refuses status %s on create, and writes nothing', async (status) => {
      const before = (await pool.query('SELECT count(*)::int n FROM invoices WHERE organization_id = $1', [ORG])).rows[0].n;
      const res = await request().post('/api/invoices').send({ member_name: 'X', amount: 900, status });
      expect(res.status).toBe(400);
      const after = (await pool.query('SELECT count(*)::int n FROM invoices WHERE organization_id = $1', [ORG])).rows[0].n;
      expect(after).toBe(before);
    });

    it('still creates a draft, sent or overdue invoice', async () => {
      for (const status of [undefined, 'draft', 'sent', 'overdue']) {
        const res = await request().post('/api/invoices').send({ member_name: 'X', amount: 900, ...(status ? { status } : {}) });
        expect(res.status).toBe(201);
        expect(res.body.invoice.status).toBe(status || 'draft');
      }
    });

    it('only mark-paid makes an invoice paid, and it books the payment', async () => {
      const inv = await newInvoice({ client_id: clientId, items: [{ description: 'PT', unit_price: 2000, quantity: 1 }] });
      const res = await request().post(`/api/invoices/${inv.id}/mark-paid`).send({ payment_method: 'CASH' });
      expect(res.status).toBe(200);
      const { rows } = await pool.query('SELECT amount FROM pt_payments WHERE payment_ref = $1 AND organization_id = $2', [inv.invoice_no, ORG]);
      expect(rows.map((r) => Number(r.amount))).toEqual([2000]);
    });
  });

  describe('a double-submitted mark-paid books the money once (Phase 4)', () => {
    it('two concurrent mark-paid requests write one payment and credit the client once', async () => {
      const { rows: [c] } = await pool.query(
        `INSERT INTO pt_clients (name, mobile, organization_id, status, final_amount, paid_amount, balance_amount)
         VALUES ('Twice Client', '9876501299', $1, 'active', 3000, 0, 3000) RETURNING id`, [ORG]);
      const inv = await newInvoice({ client_id: c.id, items: [{ description: 'PT', unit_price: 3000, quantity: 1 }] });

      const results = await Promise.all([
        request().post(`/api/invoices/${inv.id}/mark-paid`).send({ payment_method: 'CASH' }),
        request().post(`/api/invoices/${inv.id}/mark-paid`).send({ payment_method: 'CASH' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 404]);

      const { rows: pays } = await pool.query('SELECT amount FROM pt_payments WHERE client_id = $1', [c.id]);
      expect(pays.map((p) => Number(p.amount))).toEqual([3000]);
      const { rows: [after] } = await pool.query('SELECT paid_amount, balance_amount FROM pt_clients WHERE id = $1', [c.id]);
      expect(Number(after.paid_amount)).toBe(3000);
      expect(Number(after.balance_amount)).toBe(0);
    });
  });

  describe('structured invoice amounts are parsed strictly', () => {
    it.each([
      ['a negative price', { unit_price: -500, quantity: 1 }],
      ['a garbage price', { unit_price: '12abc', quantity: 1 }],
      ['a zero quantity', { unit_price: 500, quantity: 0 }],
      ['a fractional quantity', { unit_price: 500, quantity: 1.5 }],
    ])('refuses %s', async (_label, item) => {
      const res = await request().post('/api/invoices').send({ client_id: clientId, items: [{ description: 'PT', ...item }] });
      expect(res.status).toBe(400);
    });

    it.each([[-5], [101], ['18%']])('refuses tax_pct %p', async (tax) => {
      const res = await request().post('/api/invoices')
        .send({ client_id: clientId, items: [{ description: 'PT', unit_price: 500, quantity: 1 }], tax_pct: tax });
      expect(res.status).toBe(400);
    });

    it('a well-formed itemised invoice still totals correctly', async () => {
      const res = await request().post('/api/invoices').send({
        client_id: clientId, tax_pct: 18,
        items: [{ description: 'PT', unit_price: 1000, quantity: 2 }, { description: 'Diet', unit_price: '500' }],
      });
      expect(res.status).toBe(201);
      expect(Number(res.body.invoice.amount)).toBe(2500);
      expect(Number(res.body.invoice.total_amount)).toBe(2950);
    });
  });

  describe('every invoice change is audited', () => {
    it('create, update, send, mark-paid and cancel each write an activity row in this studio', async () => {
      const a = await newInvoice();
      expect(await audit('invoice.create', a.id)).toEqual([expect.objectContaining({ organization_id: ORG })]);

      expect((await request().put(`/api/invoices/${a.id}`).send({ notes: 'edited' })).status).toBe(200);
      expect(await audit('invoice.update', a.id)).toHaveLength(1);

      expect((await request().post(`/api/invoices/${a.id}/send`)).status).toBe(200);
      expect(await audit('invoice.send', a.id)).toHaveLength(1);

      expect((await request().post(`/api/invoices/${a.id}/mark-paid`).send({})).status).toBe(200);
      expect(await audit('invoice.mark_paid', a.id)).toHaveLength(1);

      const b = await newInvoice();
      expect((await request().post(`/api/invoices/${b.id}/cancel`)).status).toBe(200);
      expect(await audit('invoice.cancel', b.id)).toHaveLength(1);
    });

    it('a refused change is not audited as if it happened', async () => {
      const a = await newInvoice();
      await request().post(`/api/invoices/${a.id}/mark-paid`).send({});
      expect((await request().post(`/api/invoices/${a.id}/cancel`)).status).toBe(404);
      expect(await audit('invoice.cancel', a.id)).toHaveLength(0);
    });

    it('another studio cannot cancel this invoice, and nothing is audited for it', async () => {
      const a = await newInvoice();
      mockOrg = OTHER_ORG;
      expect((await request().post(`/api/invoices/${a.id}/cancel`)).status).toBe(404);
      mockOrg = ORG;
      expect(await audit('invoice.cancel', a.id)).toHaveLength(0);
    });
  });

  describe('every expense change is audited', () => {
    it('create, update and delete each write an activity row with the before and after', async () => {
      const created = await request().post('/api/expenses').send({ amount: 750, description: 'Chalk' });
      expect(created.status).toBe(201);
      const id = created.body.expense.id;
      expect(await audit('expense.create', id)).toHaveLength(1);

      expect((await request().put(`/api/expenses/${id}`).send({ amount: 800 })).status).toBe(200);
      const [upd] = (await pool.query(
        `SELECT old_data, new_data FROM activity_log WHERE user_id = $1 AND action = 'expense.update' AND entity_id = $2`,
        [USER, id])).rows;
      expect(Number(upd.old_data.amount)).toBe(750);
      expect(Number(upd.new_data.amount)).toBe(800);

      expect((await request().delete(`/api/expenses/${id}`)).status).toBe(200);
      expect(await audit('expense.delete', id)).toHaveLength(1);
    });
  });

  describe('every price change is audited', () => {
    it('create, update and delete of a plan each write an activity row', async () => {
      const created = await request().post('/api/plans').send({ name: 'Fin Plan', base_amount: 9000, duration: 'Monthly' });
      expect(created.status).toBe(201);
      const id = created.body.id || created.body.plan?.id || created.body.data?.id;
      expect(id).toBeTruthy();
      expect(await audit('plan.create', id)).toHaveLength(1);

      expect((await request().put(`/api/plans/${id}`).send({ final_amount: 8000 })).status).toBe(200);
      expect(await audit('plan.update', id)).toHaveLength(1);

      expect((await request().delete(`/api/plans/${id}`)).status).toBe(200);
      expect(await audit('plan.delete', id)).toHaveLength(1);
    });
  });

  describe('a malformed value is the caller\'s error, not the server\'s', () => {
    it('a non-numeric expense amount is a 400, not a 500', async () => {
      const res = await request().post('/api/expenses').send({ amount: 'lots', description: 'X' });
      expect(res.status).toBe(400);
    });
  });
});
