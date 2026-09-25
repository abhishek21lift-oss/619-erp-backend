// A member paying their own outstanding balance by UPI (migration 209).
//
// The properties that matter, each pinned here against the SQL itself:
//   • the amount is the balance the server holds, never a request value;
//   • no GST is added on top of a balance — it is already what is owed;
//   • nothing owed is refused, not turned into a zero-rupee QR;
//   • an unpaid order for a stale balance is superseded, not reused;
//   • approval moves money balance → paid and leaves the membership dates,
//     status and window alone.
'use strict';

const state = { handlers: [], log: [] };

function makeClient() {
  return {
    query: jest.fn(async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      state.log.push({ sql: flat, params });
      for (const h of state.handlers) {
        if (h.match.test(flat)) return typeof h.result === 'function' ? h.result(params) : h.result;
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
}

let mockCurrentClient;
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => mockCurrentClient.query(sql, params)),
  connect: jest.fn(async () => mockCurrentClient),
}));
jest.mock('../db/receipts', () => ({ genReceiptNo: jest.fn(async () => 'RCP-20260925-100001') }));
jest.mock('../modules/automation/automation.triggers', () => ({
  paymentReceivedFor: jest.fn(async () => {}),
}));

const upi = require('../lib/upiPayments');

function on(match, result) { state.handlers.push({ match, result }); }
const find = (re) => state.log.find((e) => re.test(e.sql));

const ORG = '11111111-1111-1111-1111-111111111111';
const ACTOR = { id: 'usr-member', name: 'Rohit', role: 'member' };
const SETTINGS = {
  upi_id: 'studio@okhdfcbank', merchant_name: 'PT Studio', gst_percent: '18.00',
  is_enabled: true, order_ttl_minutes: 30,
};

function scriptSettings() {
  on(/FROM payment_settings WHERE organization_id = \$1/, { rows: [SETTINGS] });
}
function scriptMember(balance) {
  on(/SELECT id, name, email, mobile, organization_id, balance_amount FROM pt_clients/,
    { rows: [{ id: 'client-1', name: 'Rohit', organization_id: ORG, balance_amount: balance }] });
}
function scriptInsert() {
  on(/nextval|order_no_seq|payment_order_no/i, { rows: [{ n: 100001, seq: 100001, nextval: 100001 }] });
  on(/INSERT INTO payment_orders/, (params) => ({
    rows: [{ id: params[0], order_no: params[2], client_id: params[3], plan_name: params[5],
             duration_months: params[6], base_amount: params[7], gst_percent: params[8],
             gst_amount: params[9], total_amount: params[10], kind: params[17], status: 'CREATED' }],
  }));
}

beforeEach(() => {
  state.handlers = [];
  state.log = [];
  mockCurrentClient = makeClient();
});

describe('createBalanceOrder', () => {
  test('prices the order from the stored balance, with no GST', async () => {
    scriptSettings(); scriptMember('4500.00'); scriptInsert();

    const { order, reused } = await upi.createBalanceOrder({ orgId: ORG, clientId: 'client-1', actor: ACTOR });

    expect(reused).toBe(false);
    const insert = find(/INSERT INTO payment_orders/);
    const p = insert.params;
    expect(p[3]).toBe('client-1');
    expect(p[4]).toBeNull();                         // plan_id
    expect(p[5]).toBe(upi.BALANCE_ORDER_NAME);       // plan_name
    expect(p[6]).toBe(0);                            // duration_months: buys no time
    expect(p[7]).toBe(4500);                         // base
    expect(p[8]).toBe(0);                            // gst_percent, despite the studio's 18%
    expect(p[9]).toBe(0);                            // gst_amount
    expect(p[10]).toBe(4500);                        // total
    expect(p[17]).toBe(upi.ORDER_KIND.BALANCE);
    expect(order.kind).toBe('balance');
  });

  test('reads the balance inside the caller\'s studio only', async () => {
    scriptSettings(); scriptMember('100.00'); scriptInsert();
    await upi.createBalanceOrder({ orgId: ORG, clientId: 'client-1', actor: ACTOR });

    const lookup = find(/balance_amount FROM pt_clients/);
    expect(lookup.sql).toMatch(/organization_id = \$2/);
    expect(lookup.sql).toMatch(/deleted_at IS NULL/);
    expect(lookup.params).toEqual(['client-1', ORG]);
  });

  test.each([['0.00'], ['-50'], [null]])('refuses when nothing is owed (balance %p)', async (bal) => {
    scriptSettings(); scriptMember(bal);
    await expect(upi.createBalanceOrder({ orgId: ORG, clientId: 'client-1', actor: ACTOR }))
      .rejects.toMatchObject({ code: 'NO_BALANCE', status: 409 });
    expect(find(/INSERT INTO payment_orders/)).toBeUndefined();
  });

  test('a member from another studio is not found', async () => {
    scriptSettings();
    on(/balance_amount FROM pt_clients/, { rows: [] });
    await expect(upi.createBalanceOrder({ orgId: ORG, clientId: 'client-x', actor: ACTOR }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  test('reuses an open order for the same balance', async () => {
    scriptSettings(); scriptMember('4500.00');
    on(/SELECT .* FROM payment_orders o WHERE o\.organization_id = \$1 AND o\.client_id = \$2/,
      { rows: [{ id: 'ord-open', status: 'CREATED', total_amount: '4500.00', kind: 'balance' }] });

    const { order, reused } = await upi.createBalanceOrder({ orgId: ORG, clientId: 'client-1', actor: ACTOR });

    expect(reused).toBe(true);
    expect(order.id).toBe('ord-open');
    expect(find(/INSERT INTO payment_orders/)).toBeUndefined();
  });

  test('supersedes an unpaid order for a balance that has since changed', async () => {
    scriptSettings(); scriptMember('2000.00'); scriptInsert();
    on(/SELECT .* FROM payment_orders o WHERE o\.organization_id = \$1 AND o\.client_id = \$2/,
      { rows: [{ id: 'ord-stale', status: 'PAYMENT_PENDING', total_amount: '4500.00', kind: 'balance' }] });

    const { reused } = await upi.createBalanceOrder({ orgId: ORG, clientId: 'client-1', actor: ACTOR });

    expect(reused).toBe(false);
    const cancel = find(/UPDATE payment_orders SET status = \$1 WHERE id = \$2 AND status = \$3/);
    expect(cancel.params).toEqual(['CANCELLED', 'ord-stale', 'PAYMENT_PENDING']);
    expect(find(/INSERT INTO payment_orders/).params[10]).toBe(2000);
  });

  test('never supersedes an order already awaiting verification', async () => {
    scriptSettings(); scriptMember('2000.00');
    on(/SELECT .* FROM payment_orders o WHERE o\.organization_id = \$1 AND o\.client_id = \$2/,
      { rows: [{ id: 'ord-sent', status: 'VERIFICATION_PENDING', total_amount: '4500.00', kind: 'balance' }] });

    const { order, reused } = await upi.createBalanceOrder({ orgId: ORG, clientId: 'client-1', actor: ACTOR });

    expect(reused).toBe(true);
    expect(order.id).toBe('ord-sent');
    expect(find(/UPDATE payment_orders SET status/)).toBeUndefined();
  });
});

describe('approving a balance order', () => {
  function scriptApproval() {
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 AND o\.organization_id = \$2 FOR UPDATE/, {
      rows: [{
        id: 'ord-1', organization_id: ORG, order_no: 'UPI-20260925-100001', client_id: 'client-1',
        plan_id: null, plan_name: upi.BALANCE_ORDER_NAME, kind: 'balance', duration_months: 0,
        base_amount: '4500.00', gst_percent: '0', gst_amount: '0', total_amount: '4500.00',
        status: 'VERIFICATION_PENDING',
      }],
    });
    on(/SELECT \* FROM payment_submissions WHERE payment_order_id = \$1 AND status = \$2/,
      { rows: [{ id: 'sub-1', utr: '123456789012' }] });
    on(/UPDATE payment_orders SET status = \$1 WHERE id = \$2 AND status = \$3/, { rows: [], rowCount: 1 });
    on(/FROM pt_clients WHERE id = \$1 FOR UPDATE/,
      { rows: [{ id: 'client-1', name: 'Rohit', trainer_id: null, pt_end_date: '2026-12-31' }] });
    on(/INSERT INTO membership_payments/, (params) => ({
      rows: [{ receipt_no: params[6], amount: params[7], activated_from: params[9], activated_to: params[10] }],
    }));
  }

  test('moves the money from balance to paid and leaves the membership alone', async () => {
    scriptApproval();
    await upi.approve({ orderId: 'ord-1', orgId: ORG, actor: ACTOR });

    const update = find(/UPDATE pt_clients/);
    expect(update.sql).toMatch(/paid_amount = paid_amount \+ \$1/);
    expect(update.sql).toMatch(/balance_amount = GREATEST\(0, balance_amount - \$1\)/);
    expect(update.sql).not.toMatch(/pt_end_date|pt_start_date|status/);
    expect(update.params).toEqual(['4500.00', 'client-1']);
  });

  test('records the payment with no activation window and a BALANCE_SETTLED audit', async () => {
    scriptApproval();
    const result = await upi.approve({ orderId: 'ord-1', orgId: ORG, actor: ACTOR });

    const mp = find(/INSERT INTO membership_payments/);
    expect(mp.params[9]).toBeNull();
    expect(mp.params[10]).toBeNull();
    expect(result.activation.activated_to).toBeNull();

    expect(find(/INSERT INTO pt_payments/)).toBeDefined();
    const audits = state.log.filter((e) => /INSERT INTO payment_audit_logs/.test(e.sql));
    const actions = audits.flatMap((e) => e.params).filter((v) => typeof v === 'string' && /^[A-Z_]+$/.test(v));
    expect(actions).toContain('BALANCE_SETTLED');
    expect(actions).not.toContain('MEMBERSHIP_ACTIVATED');
  });
});
