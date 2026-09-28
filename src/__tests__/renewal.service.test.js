// Renewal (payments audit 2026-09-28, PAY-2 / PAY-6 / PAY-12).
//
//   – one transaction, the client locked FOR UPDATE;
//   – the same renewal repeated inside the window is refused, not doubled;
//   – paying more than is owed is refused, not swallowed by GREATEST(…, 0);
//   – the payment carries a receipt number and the amount it applied;
//   – base_amount/discount are no longer zeroed when the screen omits them;
//   – the end date does not overflow the month.
'use strict';

const ORG = '11111111-1111-1111-1111-111111111111';

let mockClient = null;
let mockDuplicate = false;
const mockQueries = [];
const mockTx = {
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/FOR UPDATE/.test(text)) return { rows: mockClient ? [mockClient] : [], rowCount: mockClient ? 1 : 0 };
    if (/FROM pt_client_renewals/.test(text)) return { rows: [], rowCount: mockDuplicate ? 1 : 0 };
    if (/^UPDATE pt_clients/.test(text)) return { rows: [{ id: 'c1', balance_amount: params[10] }] };
    if (/^INSERT INTO pt_payments/.test(text)) return { rows: [{ id: 'pay-1' }] };
    return { rows: [], rowCount: 0 };
  }),
  release: jest.fn(),
};
jest.mock('../db/pool', () => ({ connect: jest.fn(async () => mockTx), query: jest.fn() }));
jest.mock('../db/receipts', () => ({ genReceiptNo: jest.fn(async () => 'RCP-20260928-100500') }));
jest.mock('../lib/studioTrainer', () => ({ trainerForOrg: jest.fn(async () => ({ id: 't1', incentive_rate: 0 })) }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));
jest.mock('../modules/automation/automation.triggers', () => ({ paymentReceived: jest.fn() }));

const { renewClient, addMonthsIso } = require('../modules/pt-os/renewal.service');
const automation = require('../modules/automation/automation.triggers');

const req = { user: { id: 'u1', organization_id: ORG } };
const body = (extra) => ({ pt_start_date: '2026-10-01', duration_months: 3, final_amount: 12000, paid_amount: 5000, ...extra });
const verbs = () => mockQueries.map((q) => q.sql.split(' ')[0]).filter((v) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(v));
const at = (re) => mockQueries.filter((q) => re.test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  mockDuplicate = false;
  mockClient = {
    id: 'c1', name: 'Mina', organization_id: ORG, trainer_id: 't1', trainer_name: 'T',
    package_type: 'Gold', pt_end_date: '2026-09-30', balance_amount: '2000.00', paid_amount: '20000.00',
  };
  automation.paymentReceived.mockClear();
});

test('renews inside one transaction with the client locked', async () => {
  const out = await renewClient(req, 'c1', body());
  expect(out.paymentId).toBe('pay-1');
  expect(verbs()).toEqual(['BEGIN', 'COMMIT']);
  expect(mockQueries[1].sql).toMatch(/FOR UPDATE/);
  expect(mockQueries[1].params).toEqual(['c1', ORG]);
});

test('balance is old debt + new term − paid now', async () => {
  await renewClient(req, 'c1', body());
  const [upd] = at(/^UPDATE pt_clients/);
  expect(upd.params[10]).toBe(2000 + 12000 - 5000);
  expect(upd.params[9]).toBe(5000); // added to lifetime paid
});

test('the payment has a receipt number and applies its whole amount', async () => {
  await renewClient(req, 'c1', body());
  const [ins] = at(/^INSERT INTO pt_payments/);
  expect(ins.params).toContain('RCP-20260928-100500');
  expect(ins.params[ins.params.length - 1]).toBe(5000);
  expect(automation.paymentReceived).toHaveBeenCalledWith(req, { clientId: 'c1', amount: 5000, eventKey: 'pay-1' });
});

test('a repeat of the same renewal is refused, and nothing is written', async () => {
  mockDuplicate = true;
  expect(await renewClient(req, 'c1', body())).toEqual({ duplicate: true });
  expect(verbs()).toEqual(['BEGIN', 'ROLLBACK']);
  expect(at(/^UPDATE pt_clients|^INSERT/)).toHaveLength(0);
});

test('paying more than is owed is refused', async () => {
  expect(await renewClient(req, 'c1', body({ paid_amount: 15000 }))).toEqual({ overpaid: 15000, owed: 14000 });
  expect(verbs()).toEqual(['BEGIN', 'ROLLBACK']);
});

test('no payment row, and no event, when nothing is paid now', async () => {
  await renewClient(req, 'c1', body({ paid_amount: 0 }));
  expect(at(/^INSERT INTO pt_payments/)).toHaveLength(0);
  expect(automation.paymentReceived).not.toHaveBeenCalled();
});

test('base price and discount are kept, not zeroed, when the screen sends only the final price', async () => {
  await renewClient(req, 'c1', body());
  const [upd] = at(/^UPDATE pt_clients/);
  expect(upd.params[2]).toBe(12000); // base_amount
  expect(upd.params[3]).toBe(0);     // discount
});

test('another studio\'s client is not found', async () => {
  mockClient = null;
  expect(await renewClient(req, 'c1', body())).toEqual({ notFound: true });
});

test.each([
  ['2026-01-31', 1, '2026-02-28'],
  ['2028-01-31', 1, '2028-02-29'],
  ['2026-10-01', 3, '2027-01-01'],
  ['2026-08-31', 6, '2027-02-28'],
])('%s + %i months ends %s', (start, months, end) => {
  expect(addMonthsIso(start, months)).toBe(end);
});
