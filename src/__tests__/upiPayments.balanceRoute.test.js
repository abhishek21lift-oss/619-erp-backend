// POST /api/payments/upi/balance — who may pay a balance, and for whom.
//
// The member is always the caller's own client record, and nothing in the
// body can change the amount or the member: the route passes neither on.
'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';

class MockPaymentError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

const mockUpi = {
  PaymentError: MockPaymentError,
  REJECT_REASONS: {},
  ORDER_KIND: { MEMBERSHIP: 'membership', BALANCE: 'balance' },
  createBalanceOrder: jest.fn(async () => ({
    order: { id: 'ord-1', kind: 'balance', total_amount: 4500 },
    reused: false,
    member: { id: 'ptc-1', name: 'Rohit' },
  })),
  buildPaymentView: jest.fn(async () => ({ intent_url: 'upi://pay?...' })),
};
jest.mock('../lib/upiPayments', () => mockUpi);
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../lib/fileStorage', () => ({ saveFile: jest.fn() }));
jest.mock('../lib/upiReceiptPdf', () => ({ generateUpiReceiptPdf: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../db/pool', () => ({ query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() }));

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/payments/upi', require('../routes/upi-payments'));
  a.use(errorHandler);
  return a;
}

const member = { id: 'usr-m', role: 'member', organization_id: ORG_A, pt_client_id: 'ptc-1' };

beforeEach(() => { jest.clearAllMocks(); mockUser = { ...member }; });

test('a member gets an order for their own client record, from the session', async () => {
  const res = await request(app()).post('/api/payments/upi/balance')
    .send({ client_id: 'ptc-someone-else', amount: 1, organization_id: 'other-org' });

  expect(res.status).toBe(201);
  expect(res.body.data.order.kind).toBe('balance');
  const [args] = mockUpi.createBalanceOrder.mock.calls[0];
  expect(args.clientId).toBe('ptc-1');
  expect(args.orgId).toBe(ORG_A);
  expect(args).not.toHaveProperty('amount');
});

test('a reused order is a 200, not a 201', async () => {
  mockUpi.createBalanceOrder.mockResolvedValueOnce({
    order: { id: 'ord-1', kind: 'balance' }, reused: true, member: { id: 'ptc-1', name: 'Rohit' },
  });
  const res = await request(app()).post('/api/payments/upi/balance').send({});
  expect(res.status).toBe(200);
  expect(res.body.data.reused).toBe(true);
});

test('the trainer cannot create one — staff record desk payments elsewhere', async () => {
  mockUser = { id: 'usr-t', role: 'trainer', organization_id: ORG_A };
  const res = await request(app()).post('/api/payments/upi/balance').send({});
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('MEMBERS_ONLY');
  expect(mockUpi.createBalanceOrder).not.toHaveBeenCalled();
});

test('a member login with no client record is refused', async () => {
  mockUser = { ...member, pt_client_id: null };
  const res = await request(app()).post('/api/payments/upi/balance').send({});
  expect(res.status).toBe(403);
  expect(mockUpi.createBalanceOrder).not.toHaveBeenCalled();
});

test('nothing owed surfaces as the domain\'s 409', async () => {
  mockUpi.createBalanceOrder.mockRejectedValueOnce(
    new MockPaymentError('NO_BALANCE', 'You have no outstanding balance to pay.', 409));
  const res = await request(app()).post('/api/payments/upi/balance').send({});
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('NO_BALANCE');
});
