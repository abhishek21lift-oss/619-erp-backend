'use strict';
// Renewal offers and member receipts, against a real migrated database.
//
// Proves, end to end through the real SQL:
//   - a trainer's offer is a 'renewal' order that stays open for days;
//     a second offer replaces an unpaid first one, and cannot replace one the
//     member has already paid;
//   - the member sees the offer with the window it would buy, and can ask for
//     a renewal only when there is no offer (once until the trainer looks);
//   - approving a paid offer extends the plan from its CURRENT end date,
//     writes both histories and the ledger, and leaves an older balance owed;
//   - a member can download a receipt for their own payments only.
//
// Gated on RLS_TEST_DATABASE_URL like the other real-database suites.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('member renewal against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the member renewal suite would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});

const ORG = 'c1e70000-0000-4000-8000-000000000213';
const CLIENT = 'mr-int-client';
const OTHER = 'mr-int-other';
const USER = 'mr-int-user';
const TRAINER = 'mr-int-trainer';
const TRAINER_USER = 'mr-int-trainer-user';

// The trainer routes sit behind real auth; this suite is about their SQL, so
// the session is set directly (a trainer, or a member for the refusal case).
let mockSession = null;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockSession; next(); },
  requireTrainer: (req, res, next) => (req.user?.role === 'trainer'
    ? next() : res.status(403).json({ error: { code: 'FORBIDDEN' } })),
}));

const request = require('supertest');

describeIf('member renewal against a real database', () => {
  let pool;
  let app;
  let upi;
  let asClient = CLIENT;
  const { today } = require('../lib/appTime');
  const ymd = (offsetDays) => {
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };
  const actor = { id: TRAINER_USER, name: 'Tara', role: 'trainer' };

  async function cleanup() {
    await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [[USER, TRAINER_USER]]);
    await pool.query(`DELETE FROM membership_payments WHERE organization_id = $1`, [ORG]);
    await pool.query(`DELETE FROM invoices WHERE organization_id = $1`, [ORG]);
    await pool.query(`DELETE FROM payment_audit_logs WHERE organization_id = $1`, [ORG]);
    await pool.query(`DELETE FROM payment_submissions WHERE payment_order_id IN (SELECT id FROM payment_orders WHERE organization_id = $1)`, [ORG]);
    await pool.query(`DELETE FROM payment_orders WHERE organization_id = $1`, [ORG]);
    await pool.query(`DELETE FROM payment_settings WHERE organization_id = $1`, [ORG]);
    await pool.query(`DELETE FROM pt_payments WHERE organization_id = $1`, [ORG]);
    await pool.query(`DELETE FROM pt_client_renewals WHERE client_id = ANY($1)`, [[CLIENT, OTHER]]);
    await pool.query(`DELETE FROM pt_client_subscriptions WHERE client_id = ANY($1)`, [[CLIENT, OTHER]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, TRAINER_USER]]);
    await pool.query(`DELETE FROM pt_clients WHERE id = ANY($1)`, [[CLIENT, OTHER]]);
    await pool.query(`DELETE FROM trainers WHERE id = $1`, [TRAINER]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
  }

  beforeAll(async () => {
    pool = require('../db/pool');
    upi = require('../lib/upiPayments');
    await cleanup();
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Renew Studio', 'renew-int')`, [ORG]);
    await pool.query(`INSERT INTO trainers (id, name, organization_id) VALUES ($1, 'Tara', $2)`, [TRAINER, ORG]);
    // Plan ends in 10 days; ₹500 of an older package is still owed.
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id, trainer_id, trainer_name, package_type,
                               pt_start_date, pt_end_date, duration_months, final_amount, paid_amount, balance_amount)
       VALUES ($1, 'Riya', '+919000021301', $3, $4, 'Tara', 'PT 1 month', $5, $6, 1, 9000, 8500, 500),
              ($2, 'Other', '+919000021302', $3, $4, 'Tara', NULL, NULL, NULL, NULL, 0, 0, 0)`,
      [CLIENT, OTHER, ORG, TRAINER, ymd(-20), ymd(10)]);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, pt_client_id, is_active)
       VALUES ($1, 'Riya', 'riya@renew.test', '!', 'member', $2, $3, TRUE)`, [USER, ORG, CLIENT]);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, trainer_id, is_active)
       VALUES ($1, 'Tara', 'tara@renew.test', '!', 'trainer', $2, $3, TRUE)`, [TRAINER_USER, ORG, TRAINER]);
    await pool.query(
      `INSERT INTO payment_settings (organization_id, upi_id, merchant_name, gst_percent, is_enabled)
       VALUES ($1, 'studio@okaxis', 'Renew Studio', 0, TRUE)`, [ORG]);
    await pool.query(
      `INSERT INTO pt_payments (id, client_id, amount, payment_method, payment_ref, date, notes, organization_id)
       VALUES ('mr-int-pay', $1, 8500, 'CASH', 'RCPT-MR1', $2, 'PT 1 month', $3)`, [CLIENT, ymd(-20), ORG]);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/me', (req, _res, next) => {
      req.user = { id: USER, role: 'member', organization_id: ORG, pt_client_id: asClient };
      next();
    }, require('../modules/client-portal/client-portal.routes'));
    app.use('/api/payments/upi', require('../routes/upi-payments'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  beforeEach(() => { asClient = CLIENT; });

  let offerId;

  it('shows a plan ending soon, with no offer yet', async () => {
    const res = await request(app).get('/api/me/renewal');
    expect(res.status).toBe(200);
    expect(res.body.data.plan).toMatchObject({ end_date: ymd(10), days_left: 10, phase: 'ending', balance: 500 });
    expect(res.body.data.offer).toBeNull();
  });

  it('lets the member ask once, until the trainer looks', async () => {
    expect((await request(app).post('/api/me/renewal/request').send({})).body.data).toEqual({ sent: true });
    expect((await request(app).post('/api/me/renewal/request').send({})).body.data).toEqual({ sent: false });
    const { rows } = await pool.query(
      `SELECT title, link FROM notifications WHERE user_id = $1 AND type = 'renewal_request'`, [TRAINER_USER]);
    expect(rows).toEqual([{ title: 'Riya wants to renew', link: `/pt-os/clients/${CLIENT}` }]);
    expect((await request(app).get('/api/me/renewal')).body.data.requested_at).not.toBeNull();
  });

  it('creates an offer that stays open for days, and a new one replaces it', async () => {
    const first = await upi.createRenewalOffer({ orgId: ORG, clientId: CLIENT, durationMonths: 1, amount: 9000, actor });
    expect(first.order).toMatchObject({ kind: 'renewal', status: 'CREATED', duration_months: 1, plan_name: 'PT renewal · 1 month' });
    const days = (new Date(first.order.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);

    const second = await upi.createRenewalOffer({
      orgId: ORG, clientId: CLIENT, durationMonths: 3, amount: 24000, packageName: 'PT 3 months', note: 'Loyalty price', validDays: 10, actor,
    });
    expect(second.replaced).toEqual([first.order.id]);
    const { rows } = await pool.query(`SELECT status FROM payment_orders WHERE id = $1`, [first.order.id]);
    expect(rows[0].status).toBe('CANCELLED');
    offerId = second.order.id;
  });

  it('sends an offer through the trainer route and tells the member', async () => {
    mockSession = { id: TRAINER_USER, role: 'trainer', organization_id: ORG, name: 'Tara' };
    const res = await request(app).post('/api/payments/upi/renewal-offers')
      .send({ client_id: CLIENT, duration_months: 3, amount: 24000, package_name: 'PT 3 months', note: 'Loyalty price', valid_days: 10 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ member_can_see: true, order: { kind: 'renewal', plan_name: 'PT 3 months' } });
    const note = await pool.query(`SELECT title, link FROM notifications WHERE user_id = $1 AND type = 'renewal_offer'`, [USER]);
    expect(note.rows).toEqual([{ title: 'Your renewal is ready', link: '/member/renew' }]);

    const current = await request(app).get('/api/payments/upi/renewal-offers').query({ client_id: CLIENT });
    expect(current.body.data.order.id).toBe(res.body.data.order.id);
    offerId = res.body.data.order.id;

    // Another studio's client id looks like one that does not exist.
    expect((await request(app).get('/api/payments/upi/renewal-offers').query({ client_id: 'nope' })).status).toBe(404);
    // A member cannot send themselves an offer at a price they like.
    mockSession = { id: USER, role: 'member', organization_id: ORG, pt_client_id: CLIENT };
    expect((await request(app).post('/api/payments/upi/renewal-offers')
      .send({ client_id: CLIENT, duration_months: 1, amount: 1 })).status).toBe(403);
    mockSession = null;
  });

  it('refuses nonsense offers', async () => {
    await expect(upi.createRenewalOffer({ orgId: ORG, clientId: CLIENT, durationMonths: 0, amount: 100, actor })).rejects.toThrow(/Months/);
    await expect(upi.createRenewalOffer({ orgId: ORG, clientId: CLIENT, durationMonths: 1, amount: -5, actor })).rejects.toThrow(/price/);
    await expect(upi.createRenewalOffer({ orgId: ORG, clientId: 'nobody', durationMonths: 1, amount: 100, actor })).rejects.toThrow(/not found/);
  });

  it('shows the member the offer and the window paying it would buy', async () => {
    const res = await request(app).get('/api/me/renewal');
    expect(res.body.data.offer).toMatchObject({
      id: offerId, package_name: 'PT 3 months', duration_months: 3, total_amount: 24000, note: 'Loyalty price',
      window: { activated_from: ymd(10), activated_to: upi.addMonthsIso(ymd(10), 3) },
    });
    // With an offer waiting there is nothing to request.
    expect((await request(app).post('/api/me/renewal/request').send({})).status).toBe(409);
  });

  it('keeps a paid offer from being replaced until it is verified', async () => {
    const [order] = (await pool.query(`SELECT ${upi.ORDER_COLUMNS} FROM payment_orders o WHERE o.id = $1`, [offerId])).rows;
    await upi.submitUtr({ order, utr: '412345678901', actor: { id: USER, role: 'member' } });
    await expect(upi.createRenewalOffer({ orgId: ORG, clientId: CLIENT, durationMonths: 1, amount: 9000, actor }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('approving it extends the plan from its end date, records the term, and leaves the old balance owed', async () => {
    const result = await upi.approve({ orderId: offerId, orgId: ORG, actor });
    // From the plan's end date, not today: paying early must not cost days.
    const { dbDate } = require('../lib/appTime');
    expect(dbDate(result.activation.activated_from)).toBe(ymd(10));
    expect(dbDate(result.activation.activated_to)).toBe(upi.addMonthsIso(ymd(10), 3));

    const { rows: [c] } = await pool.query(
      `SELECT package_type, pt_start_date::text, pt_end_date::text, duration_months, final_amount::float, paid_amount::float,
              balance_amount::float, status FROM pt_clients WHERE id = $1`, [CLIENT]);
    expect(c).toEqual({
      package_type: 'PT 3 months', pt_start_date: ymd(10), pt_end_date: upi.addMonthsIso(ymd(10), 3),
      duration_months: 3, final_amount: 24000, paid_amount: 8500 + 24000, balance_amount: 500, status: 'active',
    });

    const renewals = await pool.query(`SELECT new_package, old_end_date::text, paid_amount::float FROM pt_client_renewals WHERE client_id = $1`, [CLIENT]);
    expect(renewals.rows).toEqual([{ new_package: 'PT 3 months', old_end_date: ymd(10), paid_amount: 24000 }]);
    const terms = await pool.query(`SELECT source FROM pt_client_subscriptions WHERE client_id = $1`, [CLIENT]);
    expect(terms.rows).toEqual([{ source: 'upi_renewal' }]);
    const ledger = await pool.query(`SELECT amount::float FROM pt_payments WHERE client_id = $1 AND payment_method = 'UPI'`, [CLIENT]);
    expect(ledger.rows).toEqual([{ amount: 24000 }]);

    const after = await request(app).get('/api/me/renewal');
    expect(after.body.data.offer).toBeNull();
    expect(after.body.data.plan).toMatchObject({ phase: 'active', end_date: upi.addMonthsIso(ymd(10), 3) });
  });

  it('gives a member a receipt for their own payment and nobody else\'s', async () => {
    const mine = await request(app).get('/api/me/payments/mr-int-pay/receipt').buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(mine.status).toBe(200);
    expect(mine.headers['content-type']).toMatch(/pdf/);
    expect(mine.headers['cache-control']).toBe('private, no-store');
    expect(mine.body.subarray(0, 4).toString()).toBe('%PDF');

    asClient = OTHER;
    expect((await request(app).get('/api/me/payments/mr-int-pay/receipt')).status).toBe(404);
  });

  it('tells a member with no plan on record that there is nothing to renew yet', async () => {
    asClient = OTHER;
    const res = await request(app).get('/api/me/renewal');
    expect(res.body.data.plan).toMatchObject({ end_date: null, phase: 'none' });
  });
});
