'use strict';
// Operator-recorded subscription money.
//
// amount_inr used to reach subscription.activate()/changePlan() through a
// bare Number(), so the operator API accepted NaN, negative values and
// fractions. A negative amount wrote a negative payment and a negative GST
// invoice; the platform revenue KPIs moved backwards.

const ORG = '11111111-1111-1111-1111-111111111111';

const mockSubscription = {
  activate: jest.fn(async () => ({ plan_code: 'elite' })),
  changePlan: jest.fn(async () => ({ plan_code: 'elite' })),
  quotePlanChange: jest.fn(async () => ({ direction: 'activation' })),
};

jest.mock('../modules/platform/super-admin/shared', () => ({
  audit: jest.fn(async () => {}),
  invalidateUserCache: jest.fn(),
  pool: { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) },
  subscription: mockSubscription,
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { id: 'op-1', name: 'Operator', role: 'super_admin' };
    next();
  });
  a.use('/api/platform', require('../modules/platform/super-admin/subscriptions'));
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  mockSubscription.activate.mockClear();
  mockSubscription.changePlan.mockClear();
});

describe('POST /organizations/:id/subscription/activate — amount validation', () => {
  const activate = (amount) => request(app())
    .post(`/api/platform/organizations/${ORG}/subscription/activate`)
    .send({ plan_code: 'elite', amount_inr: amount });

  it.each([-1, '-50', 'abc', 1.5, '12.5', Infinity])(
    'refuses %p before anything is recorded',
    async (amount) => {
      const res = await activate(amount);
      expect(res.status).toBe(400);
      expect(mockSubscription.activate).not.toHaveBeenCalled();
    },
  );

  test('accepts a whole-rupee amount', async () => {
    const res = await activate(7999);
    expect(res.status).toBe(200);
    expect(mockSubscription.activate).toHaveBeenCalledWith(ORG, 'elite',
      expect.objectContaining({ amount_inr: 7999 }));
  });

  test('accepts ₹0 — a comp — and hands it through unchanged', async () => {
    const res = await activate(0);
    expect(res.status).toBe(200);
    expect(mockSubscription.activate).toHaveBeenCalledWith(ORG, 'elite',
      expect.objectContaining({ amount_inr: 0 }));
  });
});

describe('POST /organizations/:id/subscription/change — amount validation', () => {
  const change = (amount) => request(app())
    .post(`/api/platform/organizations/${ORG}/subscription/change`)
    .send({ plan_code: 'elite', amount_inr: amount });

  it.each([-1, 'abc', 0.5])('refuses %p before writing a payment', async (amount) => {
    const res = await change(amount);
    expect(res.status).toBe(400);
    expect(mockSubscription.changePlan).not.toHaveBeenCalled();
  });
});
