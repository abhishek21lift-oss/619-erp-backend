'use strict';
// Churn in /subscription-metrics.
//
// The metric most easily faked, so the tests are about where the number comes
// from and what it does when there is nothing to divide by.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../lib/subscription', () => ({
  ...jest.requireActual('../lib/subscription'),
  founderSlotsRemaining: jest.fn(async () => 5),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use('/api/platform', require('../modules/platform/super-admin/subscriptions'));

/**
 * Answer each of the metrics queries by matching its SQL, so the eight-way
 * Promise.all does not depend on call order.
 */
function metricsDb({ payingStudios = 10, cancelled30 = 2, cancelled90 = 5, cancelledState = 3 } = {}) {
  pool.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/AS cancelled_30d/.test(s)) return { rows: [{ cancelled_30d: cancelled30, cancelled_90d: cancelled90 }] };
    if (/AS mrr_inr[\s\S]*AS paying_studios/.test(s)) {
      return { rows: [{ mrr_inr: 50000, paying_studios: payingStudios, arpu_inr: 5000 }] };
    }
    if (/AS suspended/.test(s)) return { rows: [{ cancelled: cancelledState, total: 20 }] };
    if (/trials_started|trial_started/.test(s)) return { rows: [{ trials_started: 8, trials_converted: 4 }] };
    if (/founder/i.test(s)) return { rows: [{ granted: 1, locked_value_inr: 999, highest_number: 1 }] };
    return { rows: [] };
  });
}

const metrics = async () => (await request(app).get('/api/platform/subscription-metrics')).body.data;

beforeEach(() => { pool.query.mockReset(); });

describe('churn is counted from real cancellations', () => {
  it('reads activity_log, where cancellations are actually written', async () => {
    // The cancel handler calls audit(), which writes activity_log — not the
    // subscription_events logger the conversion and growth queries read.
    metricsDb();
    await metrics();
    const sql = pool.query.mock.calls.map(([s]) => String(s)).join('\n');
    expect(sql).toMatch(/FROM activity_log/);
    expect(sql).toMatch(/action = 'subscription_cancelled'/);
  });

  it('reports the 30- and 90-day counts it was given', async () => {
    metricsDb({ cancelled30: 2, cancelled90: 5 });
    const d = await metrics();
    expect(d.churn.cancelled_30d).toBe(2);
    expect(d.churn.cancelled_90d).toBe(5);
  });

  it('keeps the cancelled STOCK separate from the flow', async () => {
    // states.cancelled only ever rises; it is not churn and must not be
    // presented beside the 30-day figures without its own name.
    metricsDb({ cancelled30: 2, cancelledState: 3 });
    const d = await metrics();
    expect(d.churn.currently_cancelled).toBe(3);
    expect(d.churn.cancelled_30d).toBe(2);
  });
});

describe('the rate refuses to invent a denominator', () => {
  it('divides by studios paying now plus those who left in the window', async () => {
    metricsDb({ payingStudios: 18, cancelled30: 2 });
    const d = await metrics();
    // 2 / (18 + 2) = 10%
    expect(d.churn.rate_30d_pct).toBe(10);
  });

  it('is null, not zero, when there is nobody to churn', async () => {
    // A platform with no paying studios has no churn RATE. 0% reads as
    // "nobody is leaving"; the truth is "there is nobody to leave", and those
    // are opposite signals.
    metricsDb({ payingStudios: 0, cancelled30: 0 });
    const d = await metrics();
    expect(d.churn.rate_30d_pct).toBeNull();
  });

  it('is 100 when every paying studio left in the window', async () => {
    metricsDb({ payingStudios: 0, cancelled30: 4 });
    const d = await metrics();
    expect(d.churn.rate_30d_pct).toBe(100);
  });

  it('rounds to one decimal rather than printing float noise', async () => {
    metricsDb({ payingStudios: 7, cancelled30: 1 });
    const d = await metrics();
    // 1/8 = 12.5
    expect(d.churn.rate_30d_pct).toBe(12.5);
  });
});

describe('the rest of the payload is unchanged', () => {
  it('still reports MRR, ARR and conversion alongside churn', async () => {
    metricsDb();
    const d = await metrics();
    expect(d.mrr_inr).toBe(50000);
    expect(d.arr_inr).toBe(600000);
    expect(d.trial_conversion.rate_pct).toBe(50);
  });
});
