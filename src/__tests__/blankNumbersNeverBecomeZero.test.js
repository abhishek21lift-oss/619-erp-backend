'use strict';
// A blank numeric field is absent, never zero — on the server side.
//
// The frontend's form platform now refuses these before they are sent, and
// that is the right place for the message. It is not the right place for the
// GUARANTEE: the server is what any other client talks to, and three handlers
// took whatever arrived and ran it through `Number()` or `parseFloat()`.
//
// Each of the three produced a valid-looking record that nobody chose:
//
//   POST /api/pt-os/payments   `Number(amount) || 0` → a ₹0 payment row. It
//                              moves no balance and counts toward every report
//                              that counts rows, so it reads as "the member
//                              paid" forever.
//   POST /api/invoices         `parseFloat(d.amount) || 0` → a ₹0 invoice,
//                              sent to a member and entered in their accounts.
//                              parseFloat is looser still: it parses a PREFIX,
//                              so '1,500' is 1.
//   POST /api/platform/coupons `x != null ? Number(x) : null` on four caps. The
//                              guard catches undefined and null and nothing
//                              else, so '' and '  ' both became 0 — a coupon
//                              the list badges "Fully redeemed" the instant it
//                              exists, or a percentage capped at ₹0.
//
// These pin the inputs, not the SQL. Whether the statements are right is
// covered by the routes that have always run them.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

const ORG = '11111111-1111-1111-1111-111111111111';

const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'u1', name: 'Op', role: 'admin', organization_id: '11111111-1111-1111-1111-111111111111' };
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
app.use('/api/invoices', require('../routes/invoices'));
app.use('/api/diet', require('../routes/diet'));

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  mockClient.query.mockReset();
  mockClient.release.mockReset();

  pool.query.mockResolvedValue({ rows: [{ id: 'c1', organization_id: ORG }], rowCount: 1 });
  pool.connect.mockResolvedValue(mockClient);
  mockClient.query.mockResolvedValue({ rows: [{ id: 'row-1' }], rowCount: 1 });
});

/** Every statement issued on the borrowed client, whitespace-collapsed. */
const statements = () =>
  mockClient.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());

/** The parameter array of the first statement matching `re`. */
const paramsOf = (re) => {
  const call = mockClient.query.mock.calls.find(([sql]) => re.test(String(sql)));
  return call ? call[1] : null;
};

describe('POST /api/pt-os/payments — a blank amount is not ₹0', () => {
  const post = (body) => request(app).post('/api/pt-os/payments').send(body);

  it.each([
    ['omitted', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
    ['null', null],
  ])('refuses an amount that is %s', async (_label, amount) => {
    const res = await post({ client_id: 'c1', amount });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    // Nothing was written — not even a BEGIN.
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it.each(['abc', '12abc', true, [], {}])('refuses an unparseable amount (%j)', async (amount) => {
    const res = await post({ client_id: 'c1', amount });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/amount must be a number/);
  });

  it('refuses ₹0 and negative amounts — a waiver is not a payment', async () => {
    for (const amount of [0, '0', '0.00', -100]) {
      mockClient.query.mockClear();
      const res = await post({ client_id: 'c1', amount });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/greater than 0/);
    }
  });

  it('still records a real payment, with the parsed number', async () => {
    await post({ client_id: 'c1', amount: '1500.50' }).expect(201);
    const params = paramsOf(/INSERT INTO pt_payments/i);
    expect(params[2]).toBe(1500.5);
  });

  it('reads a figure typed with a separator rather than banking its prefix', async () => {
    // Number('1,500') is NaN, so this was never the silent-1 case parseFloat
    // produces on the invoice route — it was a NaN the column rejected. Either
    // way the caller now gets a 400 that names the field.
    const res = await post({ client_id: 'c1', amount: '1,500' });
    expect(res.status).toBe(400);
  });

  it('refuses a payment method outside the set the UI offers', async () => {
    const res = await post({ client_id: 'c1', amount: 500, payment_method: 'BARTER' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/payment_method must be one of/);
  });

  it.each(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER'])('accepts %s', async (method) => {
    await request(app).post('/api/pt-os/payments')
      .send({ client_id: 'c1', amount: 500, payment_method: method })
      .expect(201);
  });
});

describe('POST /api/invoices — a blank amount is not a ₹0 invoice', () => {
  const post = (body) => request(app).post('/api/invoices').send(body);

  it.each([
    ['empty string', ''],
    ['whitespace', '  '],
  ])('refuses a simplified invoice whose amount is %s', async (_label, amount) => {
    const res = await post({ member_name: 'Rahul', amount, due_date: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/);
    // Rolled back rather than committed with a zero.
    expect(statements()).not.toContain('COMMIT');
  });

  it('refuses a prefix-parseable amount rather than banking the prefix', async () => {
    // parseFloat('12abc') is 12. An invoice for the wrong amount is worse than
    // a rejected request: it is sent to a member and entered in their accounts.
    const res = await post({ member_name: 'Rahul', amount: '12abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be a number/);
  });

  it('refuses ₹0 and negative', async () => {
    for (const amount of [0, '0', -50]) {
      mockClient.query.mockClear();
      const res = await post({ member_name: 'Rahul', amount });
      expect(res.status).toBe(400);
    }
  });

  it('releases the connection on every refusal, so a rejected body cannot leak one', async () => {
    // A borrowed client that is never released costs one of the pool's
    // connections per bad request, which ends as an outage rather than an error.
    await post({ member_name: 'Rahul', amount: '' });
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('still creates a real invoice', async () => {
    await post({ member_name: 'Rahul', amount: '4999', due_date: '2026-03-01' }).expect(201);
    const params = paramsOf(/INSERT INTO invoices/i);
    expect(params[4]).toBe(4999);
  });
});

describe('POST /api/platform/coupons — a blank cap is no limit, not zero', () => {
  // Mounted separately: the super-admin routers pull in a large shared module,
  // and only this one route is under test.
  const couponApp = express();
  couponApp.use(express.json());
  // The super-admin routers do not call `auth` themselves — the parent mount
  // does — so the operator has to be supplied here.
  couponApp.use((req, _res, next) => {
    req.user = { id: 'u1', name: 'Op', role: 'super_admin' };
    next();
  });
  couponApp.use('/api/platform', require('../modules/platform/super-admin/subscriptions'));

  const post = (body) => request(couponApp).post('/api/platform/coupons').send({
    code: 'LAUNCH20', discount_type: 'percent', discount_value: 20, ...body,
  });

  const insertParams = () => {
    const call = pool.query.mock.calls.find(([sql]) => /INSERT INTO subscription_coupons/i.test(String(sql)));
    return call ? call[1] : null;
  };

  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [{ id: 'coupon-1', code: 'LAUNCH20' }], rowCount: 1 });
  });

  it.each([
    ['max_redemptions'],
    ['max_per_org'],
    ['max_discount_inr'],
    ['min_amount_inr'],
  ])('treats a blank %s as absent rather than as 0', async (field) => {
    await post({ [field]: '' }).expect(201);
    const params = insertParams();
    // Positions in the INSERT's parameter list.
    const at = {
      max_discount_inr: 4, min_amount_inr: 5, max_redemptions: 7, max_per_org: 8,
    }[field];
    expect(params[at]).toBeNull();
  });

  it.each(['max_redemptions', 'max_per_org', 'max_discount_inr'])(
    'treats whitespace in %s as absent — the case the old truthiness guard missed',
    async (field) => {
      // `'   '` is truthy, so `Number('   ')` ran and produced 0. On
      // max_redemptions that is a coupon the list badges "Fully redeemed" the
      // instant it exists, because times_redeemed >= max_redemptions.
      await post({ [field]: '   ' }).expect(201);
      const at = { max_discount_inr: 4, max_redemptions: 7, max_per_org: 8 }[field];
      expect(insertParams()[at]).toBeNull();
    },
  );

  it.each(['max_redemptions', 'max_per_org', 'max_discount_inr'])(
    'refuses an explicit 0 in %s rather than storing an unusable coupon',
    async (field) => {
      const res = await post({ [field]: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/greater than 0/);
    },
  );

  it('refuses a typo with a 400 that names the field, not a 500 from the column', async () => {
    const res = await post({ max_redemptions: '2o' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('max_redemptions must be a number');
  });

  it('COALESCE does not rescue a zero max_per_org, which is why 0 is refused', async () => {
    // COALESCE($9,1) replaces NULL. 0 is not NULL, so a zero would have gone
    // through as a coupon no studio can ever redeem.
    await post({}).expect(201);
    expect(insertParams()[8]).toBeNull();
    const sql = pool.query.mock.calls.find(([s]) => /INSERT INTO subscription_coupons/i.test(String(s)))[0];
    expect(String(sql)).toMatch(/COALESCE\(\$9,1\)/);
  });

  it('still stores the caps an operator actually set', async () => {
    await post({ max_redemptions: 20, max_per_org: '2', max_discount_inr: '2000' }).expect(201);
    const params = insertParams();
    expect(params[4]).toBe(2000);
    expect(params[7]).toBe(20);
    expect(params[8]).toBe(2);
  });
});

describe('POST /api/diet/meals — a blank macro is unknown, not zero', () => {
  const post = (body) => request(app).post('/api/diet/meals').send({
    name: 'Grilled chicken', meal_type: 'lunch', calories: 320, ...body,
  });

  const insertParams = () => {
    const call = pool.query.mock.calls.find(([sql]) => /INSERT INTO meals/i.test(String(sql)));
    return call ? call[1] : null;
  };

  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [{ id: 'meal-1' }], rowCount: 1 });
  });

  it.each(['protein_g', 'carbs_g', 'fats_g'])(
    'stores null for a blank %s rather than 0',
    async (field) => {
      // `parseFloat(d[field]) || 0` stored zero. Every plan that includes the
      // meal then totals its protein as though it contributes none.
      await post({ [field]: '' }).expect(201);
      const at = { protein_g: 5, carbs_g: 6, fats_g: 7 }[field];
      expect(insertParams()[at]).toBeNull();
    },
  );

  it('stores null when a macro is omitted entirely', async () => {
    await post({}).expect(201);
    const p = insertParams();
    expect(p[5]).toBeNull();
    expect(p[6]).toBeNull();
    expect(p[7]).toBeNull();
  });

  it('keeps a DELIBERATE zero — black coffee really is 0 g of fat', async () => {
    await post({ fats_g: 0 }).expect(201);
    expect(insertParams()[7]).toBe(0);
  });

  it('stores the macros a coach actually measured', async () => {
    await post({ protein_g: '31.5', carbs_g: 0, fats_g: '3.2' }).expect(201);
    const p = insertParams();
    expect(p[5]).toBe(31.5);
    expect(p[6]).toBe(0);
    expect(p[7]).toBe(3.2);
  });

  it('refuses an unparseable macro rather than silently zeroing it', async () => {
    const res = await post({ protein_g: '31g' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/protein_g must be a number/);
  });

  it('refuses a negative macro', async () => {
    expect((await post({ carbs_g: -5 })).status).toBe(400);
  });

  it('requires calories, because the column cannot hold "unknown"', async () => {
    // `calories INT NOT NULL DEFAULT 0` — migration 006. A blank used to become
    // a 0 that then reads as a fact on every plan total.
    for (const calories of ['', '   ', null, undefined]) {
      pool.query.mockClear();
      const res = await post({ calories });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/calories/);
    }
  });

  it('refuses fractional or negative calories', async () => {
    expect((await post({ calories: '320.5' })).status).toBe(400);
    expect((await post({ calories: -1 })).status).toBe(400);
  });
});
