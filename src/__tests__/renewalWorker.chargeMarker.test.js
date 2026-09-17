// runAutoRenew() (src/workers/renewal.worker.js) charges a membership via
// Razorpay and rolls it over inside one DB transaction. If the process died
// after the charge succeeded but before that transaction committed, ROLLBACK
// put the membership row right back into next run's WHERE clause (same
// status='active', same end_date) — but the Razorpay charge is not something
// a Postgres ROLLBACK can undo. A manual re-run (or an overlapping cron tick)
// would charge the member a second time. Fixed with a charge marker
// (migration 206) written independently of the rollover transaction, checked
// before charging, and a deterministic receipt (member+date, not Date.now()).
'use strict';

const mockPoolQueries = [];
let mockClient;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockPoolQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(async () => mockClient),
}));

jest.mock('../lib/razorpay', () => ({
  isConfigured: jest.fn(() => true),
  createOrder: jest.fn(async () => ({ id: 'order_1', status: 'created' })),
  capturePayment: jest.fn(async () => ({ id: 'pay_1', status: 'captured' })),
}));

jest.mock('../modules/notifications/notifications.service', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const pool = require('../db/pool');
const razorpay = require('../lib/razorpay');
const logger = require('../lib/logger');
const { runAutoRenew } = require('../workers/renewal.worker');

const TODAY = new Date().toISOString().slice(0, 10);

function membershipRow(overrides = {}) {
  return {
    id: 'mm-1', member_id: 'mem-1', plan_id: 'plan-1', trainer_id: null,
    name: 'Riya', email: 'riya@example.com', phone: '+911234567890', user_id: 'u-1',
    plan_name: 'Gold', duration: 30, price: 1999,
    last_renewal_charge_at: null, last_renewal_order_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockPoolQueries.length = 0;
  jest.clearAllMocks();
  razorpay.isConfigured.mockReturnValue(true);
  razorpay.createOrder.mockResolvedValue({ id: 'order_1', status: 'created' });
  razorpay.capturePayment.mockResolvedValue({ id: 'pay_1', status: 'captured' });
  mockClient = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
});

test('a membership already charged today is skipped, not charged again', async () => {
  pool.query.mockImplementationOnce(async (sql) => {
    mockPoolQueries.push({ sql: String(sql) });
    return { rows: [membershipRow({ last_renewal_charge_at: new Date().toISOString(), last_renewal_order_id: 'order_0' })] };
  });

  await runAutoRenew();

  expect(razorpay.createOrder).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith(
    expect.objectContaining({ membership_id: 'mm-1' }),
    expect.stringContaining('auto_renew_skipped_already_charged_today')
  );
});

test('a membership never charged today is charged with a deterministic (member+date) receipt', async () => {
  pool.query.mockImplementationOnce(async (sql) => {
    mockPoolQueries.push({ sql: String(sql) });
    return { rows: [membershipRow()] };
  });

  await runAutoRenew();

  expect(razorpay.createOrder).toHaveBeenCalledWith(
    expect.any(Number), 'INR', `renew_mm-1_${TODAY}`
  );
});

test('the charge marker is written independently of the rollover transaction (via pool, not the tx client)', async () => {
  pool.query.mockImplementationOnce(async (sql) => {
    mockPoolQueries.push({ sql: String(sql) });
    return { rows: [membershipRow()] };
  });

  await runAutoRenew();

  const markerWrite = mockPoolQueries.find((q) => /last_renewal_charge_at\s*=\s*NOW\(\)/.test(q.sql));
  expect(markerWrite).toBeTruthy();
  // It must not have gone through the transaction client (which BEGINs/COMMITs
  // around the rollover) — the whole point is that it survives a ROLLBACK.
  expect(mockClient.query.mock.calls.some(([sql]) => /last_renewal_charge_at/.test(String(sql)))).toBe(false);
});
