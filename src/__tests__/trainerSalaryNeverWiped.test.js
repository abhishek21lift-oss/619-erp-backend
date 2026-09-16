'use strict';
// A partial update wiped a trainer's salary to ₹0.
//
// PUT /api/trainers/:id builds its parameter list by preserving what the
// request did not carry — every field except one:
//
//   d.name?.trim() || ex[0].name
//   d.role         || ex[0].role
//   d.status       || ex[0].status
//   rate          ?? ex[0].incentive_rate
//   parseFloat(d.salary) || 0            ← no fallback at all
//
// `salary` is `.optional()` in trainerSchemas.update, so a body that omits it
// passes validation, reaches `parseFloat(undefined)` — which is NaN — and
// `NaN || 0` is 0. Any update that did not resend the salary set it to zero:
// changing a phone number, a status, a note.
//
// The figure feeds payroll and every salary-cost report, and nothing on the
// screen would say it had happened.
//
// `incentive_rate` in the same statement already shows the intended shape, so
// the fix is to make salary behave like its sibling rather than to invent one.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

const ORG = '11111111-1111-1111-1111-111111111111';

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'u1', name: 'Op', role: 'admin', organization_id: ORG };
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
app.use('/api/trainers', require('../routes/trainers'));

/** The trainer already on file, with a real salary and incentive rate. */
const EXISTING = {
  id: 't1',
  name: 'Asha',
  role: 'Personal Trainer',
  status: 'active',
  salary: 50000,
  incentive_rate: 0.5,
  biometric_code: 'STF-1',
  organization_id: ORG,
  metadata: {},
};

beforeEach(() => {
  pool.query.mockReset();
  // 1st: the SELECT that loads the existing row. Everything after: the UPDATE
  // and the re-SELECT.
  pool.query
    .mockResolvedValueOnce({ rows: [EXISTING], rowCount: 1 })
    .mockResolvedValue({ rows: [EXISTING], rowCount: 1 });
});

/** The parameter array of the first UPDATE statement issued. */
const updateParams = () => {
  const call = pool.query.mock.calls.find(([sql]) => /UPDATE trainers SET/i.test(String(sql)));
  return call ? call[1] : null;
};

/** `salary` is the 9th column in the UPDATE's SET list, so $9 → index 8. */
const salaryParam = () => {
  const p = updateParams();
  return p ? p[8] : undefined;
};

describe('PUT /api/trainers/:id — salary survives an update that omits it', () => {
  const put = (body) => request(app).put('/api/trainers/t1').send(body);

  test('changing only the phone number leaves the salary alone', async () => {
    const res = await put({ mobile: '9876543210' });
    expect(res.status).toBe(200);
    expect(salaryParam()).toBe(50000);
  });

  test('changing only the status leaves the salary alone', async () => {
    await put({ status: 'inactive' });
    expect(salaryParam()).toBe(50000);
  });

  test('an empty body leaves the salary alone', async () => {
    await put({});
    expect(salaryParam()).toBe(50000);
  });

  test('a new salary is still written when one IS sent', async () => {
    await put({ salary: 62000 });
    expect(salaryParam()).toBe(62000);
  });

  test('a salary of zero is honoured — it is a real value, not an absence', async () => {
    // An unpaid or commission-only trainer is a real case, and it must be
    // distinguishable from "not sent".
    await put({ salary: 0 });
    expect(salaryParam()).toBe(0);
  });

  test('behaves like its sibling: incentive_rate is preserved the same way', async () => {
    // The shape this fix copies. `rate ?? ex[0].incentive_rate` was already
    // right; salary simply never got the same treatment.
    await put({ mobile: '9876543210' });
    const p = updateParams();
    expect(p[9]).toBe(0.5);
  });
});
