// Flow tests for subscription.activate() — recording a studio's payment
// against the platform (super admin's manual "Record Payment", and the
// delegate underneath self-checkout approval).
//
// This covers the double-invoice bug: the manual activation path had no
// protection at all against the same transaction being recorded twice, unlike
// every other payment path in this system (upiPayments.js, subscriptionCheckout.js)
// which all reject a repeated reference/UTR with a clean 409. A double click
// on "Record Payment", or an operator pasting the same UTR twice, used to mint
// a second subscription_payments row and a second subscription_invoices row
// for one real transaction.
'use strict';

const state = { handlers: [], log: [] };

function makeClient() {
  return {
    query: jest.fn(async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      state.log.push({ sql: flat, params });
      for (const h of state.handlers) {
        if (h.match.test(flat)) {
          if (h.throws) throw h.throws;
          return typeof h.result === 'function' ? h.result(params) : h.result;
        }
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

const subscription = require('../lib/subscription');

function on(match, result) { state.handlers.push({ match, result }); }
function onThrow(match, error) { state.handlers.push({ match, throws: error }); }
function sqlLog() { return state.log.map((e) => e.sql); }
function ranSql(re) { return sqlLog().some((s) => re.test(s)); }

const ORG = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  state.handlers = [];
  state.log = [];
  mockCurrentClient = makeClient();
});

// Scripts every query a clean, no-founder, no-coupon activation needs, up to
// (and including) the payment insert — enough to reach the point each test
// cares about.
function scriptHappyPathUpToPayment({ paymentThrows } = {}) {
  on(/^SELECT \* FROM subscription_plans WHERE code = \$1/,
    { rows: [{ code: 'pro', client_limit: 100, price_inr: 1999, launch_price_inr: null, duration_months: 1 }] });
  on(/^SELECT \* FROM organizations WHERE id = \$1/,
    { rows: [{ id: ORG, is_founder: false, founder_number: null, locked_price_inr: null, current_period_end: null }] });
  on(/^SELECT count\(\*\)::int AS n FROM founder_members/, { rows: [{ n: 20 }] }); // slots exhausted → no founder path
  on(/^UPDATE organizations SET subscription_status/, { rows: [], rowCount: 1 });
  if (paymentThrows) {
    onThrow(/^INSERT INTO subscription_payments/s, paymentThrows);
  } else {
    on(/^INSERT INTO subscription_payments/s, { rows: [{ id: 'pay-1' }] });
    on(/^SELECT \* FROM platform_billing_settings WHERE id = TRUE/, { rows: [] });
    on(/^SELECT count\(\*\)\+1 AS n FROM subscription_invoices/, { rows: [{ n: 3 }] });
    on(/^INSERT INTO subscription_invoices/s, { rows: [], rowCount: 1 });
  }
}

describe('duplicate payment reference protection', () => {
  test('the same reference already recorded as paid is rejected before touching the ledger', async () => {
    on(/^SELECT invoice_number FROM subscription_invoices si/s,
      { rows: [{ invoice_number: 'MPT-2026-00001' }] });

    await expect(subscription.activate(ORG, 'pro', {
      amount_inr: 7999, method: 'upi', reference: 'UTR123',
    })).rejects.toMatchObject({ code: 'DUPLICATE_REFERENCE', status: 409 });

    // Rejected up front — must never reach the payment/invoice inserts, and
    // the transaction must be rolled back rather than left open.
    expect(ranSql(/^INSERT INTO subscription_payments/)).toBe(false);
    expect(ranSql(/^INSERT INTO subscription_invoices/)).toBe(false);
    expect(ranSql(/^ROLLBACK$/)).toBe(true);
    expect(ranSql(/^COMMIT$/)).toBe(false);
  });

  test('a database-level collision on the reference is still turned into a clean 409 (the race the pre-check cannot close alone)', async () => {
    on(/^SELECT invoice_number FROM subscription_invoices si/s, { rows: [] }); // pre-check sees nothing yet
    scriptHappyPathUpToPayment({
      paymentThrows: Object.assign(new Error('duplicate key'), {
        code: '23505', constraint: 'uq_sub_payments_live_reference',
      }),
    });

    await expect(subscription.activate(ORG, 'pro', {
      amount_inr: 7999, method: 'upi', reference: 'UTR123',
    })).rejects.toMatchObject({ code: 'DUPLICATE_REFERENCE', status: 409 });

    expect(ranSql(/^ROLLBACK$/)).toBe(true);
    expect(ranSql(/^COMMIT$/)).toBe(false);
  });

  test('a non-duplicate database error on the payment insert is not swallowed as a duplicate', async () => {
    on(/^SELECT invoice_number FROM subscription_invoices si/s, { rows: [] });
    scriptHappyPathUpToPayment({
      paymentThrows: Object.assign(new Error('connection reset'), { code: '08006' }),
    });

    await expect(subscription.activate(ORG, 'pro', {
      amount_inr: 7999, method: 'upi', reference: 'UTR123',
    })).rejects.toMatchObject({ message: 'connection reset' });
  });

  test('every activation takes a per-organization advisory lock, so two requests for the same studio cannot race past the pre-check together', async () => {
    on(/^SELECT invoice_number FROM subscription_invoices si/s, { rows: [] });
    scriptHappyPathUpToPayment();

    await subscription.activate(ORG, 'pro', { amount_inr: 7999, method: 'upi', reference: 'UTR123' });

    expect(ranSql(/^SELECT pg_advisory_xact_lock\(hashtext\(\$1\)\)/)).toBe(true);
    expect(ranSql(/^COMMIT$/)).toBe(true);
  });

  test('a payment recorded with no reference (cash, comp) is unaffected — nothing to dedupe against', async () => {
    scriptHappyPathUpToPayment();

    await expect(subscription.activate(ORG, 'pro', {
      amount_inr: 7999, method: 'cash',
    })).resolves.toMatchObject({ invoice_number: expect.stringContaining('MPT-') });

    // No reference given → the dedupe pre-check must not even run.
    expect(ranSql(/^SELECT invoice_number FROM subscription_invoices si/)).toBe(false);
  });
});
