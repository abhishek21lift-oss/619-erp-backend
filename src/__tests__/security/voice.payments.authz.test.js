// Phase 7 — payments by voice.
//
// The most sensitive read on this surface and the most sensitive write, and
// they fail in different directions:
//
//   READ  — says a number out loud in a room. The failure is saying MORE than
//           was asked: a ledger, a receipt number, a payment history. A
//           balance overheard is bad; a client's finances narrated to whoever
//           is standing there is worse, and cannot be un-said.
//   WRITE — creates money. The failures are recording an amount nobody
//           confirmed, and recording the same one twice.
//
// The property that carries the write is that the AMOUNT NEVER TRAVELS BACK
// FROM THE PHONE. If /confirm accepted an amount, the sentence Siri read out
// and the figure written would be two independent values and the confirmation
// would guarantee nothing at all.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const DRAFT_ID = '44444444-4444-4444-8444-444444444444';
const CLIENT_ID = 'ptc-rahul';

const mockLog = [];
let mockResponder;

jest.mock('../../db/pool', () => {
  const query = jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: flat, params });
    const rows = mockResponder(flat, params);
    return { rows, rowCount: rows.length };
  });
  return { query, connect: jest.fn(async () => ({ query, release: jest.fn() })) };
});

jest.mock('../../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../lib/ai/router', () => ({ routedChat: jest.fn(), routedStream: jest.fn() }));

// Receipt numbers come from a Postgres sequence; stubbed so assertions about
// the ledger row do not depend on sequence state.
jest.mock('../../db/receipts', () => ({
  genReceiptNo: jest.fn(async () => 'RCP-20260822-100001'),
}));

let mockUser;
jest.mock('../../middleware/auth', () => ({
  ...jest.requireActual('../../middleware/auth'),
  auth: (req, res, next) => {
    if (!mockUser) return res.status(401).json({ error: 'Unauthorized' });
    req.user = mockUser;
    next();
  },
  adminOnly: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../../middleware/errorHandler');
const { today: studioToday } = require('../../lib/appTime');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/voice', require('../../routes/voice'));
  a.use(errorHandler);
  return a;
}

const statusUrl = (id = CLIENT_ID) => `/api/voice/payments/client/${id}/status`;
const status  = (id) => request(app()).get(statusUrl(id));
const prepare = (body = { client_id: CLIENT_ID, amount: 3000 }) =>
  request(app()).post('/api/voice/payments/prepare').send(body);
const confirm = (body = { draft_id: DRAFT_ID }) =>
  request(app()).post('/api/voice/payments/confirm').send(body);

const q = (re) => mockLog.find((x) => re.test(x.sql));
const clientRead   = () => q(/^SELECT id, name, balance_amount, paid_amount/i);
const lastPayQuery = () => q(/^SELECT amount, status, date::TEXT/i);
const dupQuery     = () => q(/AND amount = \$2 AND created_at > NOW\(\)/i);
const draftInsert  = () => q(/INSERT INTO voice_payment_drafts/i);
const draftClaim   = () => q(/UPDATE voice_payment_drafts SET status = 'confirmed'/i);
const lockQuery    = () => q(/FROM pt_clients WHERE id = \$1 AND deleted_at IS NULL FOR UPDATE/i);
const ledgerInsert = () => q(/INSERT INTO pt_payments/i);
const balanceMove  = () => q(/UPDATE pt_clients SET paid_amount = paid_amount/i);

const ADMIN_A   = { id: 'u-a', name: 'Admin A', role: 'admin', organization_id: ORG_A, trainer_id: null };
const ADMIN_B   = { id: 'u-b', name: 'Admin B', role: 'admin', organization_id: ORG_B, trainer_id: null };
const OTHER_A   = { id: 'u-a2', name: 'Admin A2', role: 'admin', organization_id: ORG_A, trainer_id: null };
const MANAGER_A = { id: 'u-mg', name: 'Manager A', role: 'manager', organization_id: ORG_A, trainer_id: null };
const TRAINER_A = { id: 'u-t', name: 'Trainer A', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-a' };
const TRAINER_NONE = { id: 'u-tx', name: 'Trainer X', role: 'trainer', organization_id: ORG_A, trainer_id: null };
const RECEPT_A  = { id: 'u-rc', name: 'Reception', role: 'reception', organization_id: ORG_A, trainer_id: null };
const MEMBER_A  = { id: 'u-m', name: 'Client', role: 'member', organization_id: ORG_A };
const ORPHAN    = { id: 'u-o', name: 'Orphan', role: 'admin', organization_id: null, trainer_id: null };

const CLIENT = {
  id: CLIENT_ID, name: 'Rahul Sharma', balance_amount: '5000.00',
  paid_amount: '10000.00', final_amount: '15000.00',
  package_type: 'PT Gold', pt_end_date: '2099-09-14',
  organization_id: ORG_A, trainer_id: 'trn-a',
};

function world(o = {}) {
  const {
    owned = true, trainerOwns = true, client = CLIENT,
    lastPayment = [{ amount: '2000.00', status: 'completed', date: '2026-08-01' }],
    duplicate = [], trainerRow = [{ id: 'trn-a', incentive_rate: 0.5 }],
    claim = [{
      id: DRAFT_ID, client_id: CLIENT_ID, amount: '3000.00',
      payment_method: 'CASH', notes: null,
    }],
  } = o;

  return (sql) => {
    if (/^SELECT 1 FROM pt_clients WHERE id = \$1 AND trainer_id/i.test(sql)) return trainerOwns ? [{ '?column?': 1 }] : [];
    if (/^SELECT 1 FROM pt_clients/i.test(sql)) return owned ? [{ '?column?': 1 }] : [];
    if (/FOR UPDATE/i.test(sql)) return client ? [client] : [];
    if (/^SELECT id, name, balance_amount, paid_amount/i.test(sql)) return client ? [client] : [];
    if (/^SELECT id, name, balance_amount FROM pt_clients/i.test(sql)) return client ? [client] : [];
    if (/^SELECT amount, status, date::TEXT/i.test(sql)) return lastPayment;
    if (/AND amount = \$2 AND created_at > NOW\(\)/i.test(sql)) return duplicate;
    if (/FROM trainers WHERE id=\$1/i.test(sql)) return trainerRow;
    if (/INSERT INTO voice_payment_drafts/i.test(sql)) {
      return [{ id: DRAFT_ID, expires_at: new Date(Date.now() + 600e3).toISOString() }];
    }
    if (/UPDATE voice_payment_drafts SET status = 'confirmed'/i.test(sql)) return claim;
    return [];
  };
}

beforeEach(() => {
  mockLog.length = 0;
  mockUser = ADMIN_A;
  mockResponder = world();
});

// ── A. Payment status ─────────────────────────────────────────────────────
describe('A. checking payment status', () => {
  test('returns the outstanding amount and the latest payment', async () => {
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body.outstanding).toBe(5000);
    expect(res.body.currency).toBe('INR');
    expect(res.body.last_payment).toEqual({ amount: 2000, status: 'completed', date: '2026-08-01' });
    expect(res.body.package).toEqual({ type: 'PT Gold', expires_on: '2099-09-14' });
  });

  test('speaks the balance as words, not a currency symbol', async () => {
    const res = await status();
    expect(res.body.spoken).toContain('Rahul has 5,000 rupees outstanding.');
    expect(res.body.spoken).not.toContain('₹');
  });

  test('groups large amounts the Indian way', async () => {
    mockResponder = world({ client: { ...CLIENT, balance_amount: '150000.00' } });
    const res = await status();
    expect(res.body.spoken).toContain('1,50,000 rupees');
  });

  test('a settled client is told plainly', async () => {
    mockResponder = world({ client: { ...CLIENT, balance_amount: '0.00' } });
    const res = await status();
    expect(res.body.outstanding).toBe(0);
    expect(res.body.spoken).toContain('Rahul has no pending payment.');
  });

  test('NO balance on file is not spoken as "no pending payment"', async () => {
    mockResponder = world({ client: { ...CLIENT, balance_amount: null } });
    const res = await status();
    expect(res.body.outstanding).toBeNull();
    expect(res.body.spoken).toMatch(/do not have an outstanding balance on file/i);
    expect(res.body.spoken).not.toMatch(/no pending payment/i);
  });

  test('a client with no payments says so rather than inventing one', async () => {
    mockResponder = world({ lastPayment: [] });
    const res = await status();
    expect(res.body.last_payment).toBeNull();
    expect(res.body.spoken).toMatch(/no payments on record/i);
  });

  test('a pending last payment is described as pending', async () => {
    mockResponder = world({ lastPayment: [{ amount: '2000.00', status: 'pending', date: '2026-08-01' }] });
    const res = await status();
    expect(res.body.spoken).toMatch(/is pending/i);
  });

  test('the package renewal is volunteered only when something is owed', async () => {
    let res = await status();
    expect(res.body.spoken).toMatch(/package runs to/i);

    mockLog.length = 0;
    mockResponder = world({ client: { ...CLIENT, balance_amount: '0.00' } });
    res = await status();
    expect(res.body.spoken).not.toMatch(/package runs to/i);
  });

  test('a failed last-payment read does not fail the answer', async () => {
    mockResponder = (sql) => {
      if (/^SELECT amount, status, date::TEXT/i.test(sql)) throw new Error('timeout');
      return world()(sql);
    };
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body.outstanding).toBe(5000);
  });
});

// ── B. The read exposes nothing extra ─────────────────────────────────────
describe('B. nothing unnecessary is exposed', () => {
  test('only the LATEST payment is read — never a history', async () => {
    await status();
    expect(lastPayQuery().sql).toMatch(/LIMIT 1/);
  });

  test('no receipt number, method or note is selected', async () => {
    await status();
    expect(lastPayQuery().sql).not.toMatch(/payment_ref|payment_method|notes|incentive/i);
  });

  test('no contact detail is selected', async () => {
    await status();
    for (const x of mockLog) {
      expect(x.sql).not.toMatch(/\bmobile\b|\bemail\b|\baddress\b/i);
    }
  });

  test('no identifier appears in the spoken sentence', async () => {
    const res = await status();
    expect(res.body.spoken).not.toContain(CLIENT_ID);
    expect(res.body.spoken).not.toContain(ORG_A);
  });

  test('only the first name is spoken', async () => {
    const res = await status();
    expect(res.body.spoken).not.toContain('Sharma');
  });
});

// ── C. Authorization ──────────────────────────────────────────────────────
describe('C. authorization', () => {
  test('an unauthenticated request is refused', async () => {
    mockUser = null;
    expect((await status()).status).toBe(401);
    expect((await prepare()).status).toBe(401);
    expect((await confirm()).status).toBe(401);
  });

  test('a gym member cannot even check a balance', async () => {
    mockUser = MEMBER_A;
    const res = await status();
    expect(res.status).toBe(403);
    expect(clientRead()).toBeUndefined();
  });

  test('reception MAY check a balance', async () => {
    mockUser = RECEPT_A;
    expect((await status()).status).toBe(200);
  });

  test('reception may NOT record a payment', async () => {
    mockUser = RECEPT_A;
    const res = await prepare();
    expect(res.status).toBe(403);
    expect(draftInsert()).toBeUndefined();
  });

  test('reception may not confirm one either', async () => {
    mockUser = RECEPT_A;
    const res = await confirm();
    expect(res.status).toBe(403);
    expect(draftClaim()).toBeUndefined();
    expect(ledgerInsert()).toBeUndefined();
  });

  test.each([['admin', ADMIN_A], ['manager', MANAGER_A], ['trainer', TRAINER_A]])(
    '%s may prepare a payment', async (_l, u) => {
      mockUser = u;
      expect((await prepare()).status).toBe(201);
    });

  test('a trainer cannot take payment for a colleague\'s client', async () => {
    mockUser = TRAINER_A;
    mockResponder = world({ trainerOwns: false });
    const res = await prepare();
    expect(res.status).toBe(404);
    expect(draftInsert()).toBeUndefined();
  });

  test('a trainer with no trainer record cannot read a balance', async () => {
    mockUser = TRAINER_NONE;
    expect((await status()).status).toBe(404);
  });

  test('the trainer check is RE-RUN at confirm, against the live row', async () => {
    mockUser = TRAINER_A;
    mockResponder = world({ client: { ...CLIENT, trainer_id: 'trn-someone-else' } });
    const res = await confirm();
    expect(res.status).toBe(404);
    expect(ledgerInsert()).toBeUndefined();
    expect(q(/^ROLLBACK$/i)).toBeDefined();
  });
});

// ── D. Cross-organization ─────────────────────────────────────────────────
describe('D. cross-organization access', () => {
  test('another studio\'s client is 404, NOT 403', async () => {
    mockResponder = world({ owned: false });
    mockUser = ADMIN_B;
    const res = await status();
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('a foreign client is refused before any money is read', async () => {
    mockResponder = world({ owned: false });
    await status();
    expect(clientRead()).toBeUndefined();
    expect(lastPayQuery()).toBeUndefined();
  });

  test('the balance read is org-filtered', async () => {
    await status();
    expect(clientRead().sql).toMatch(/organization_id = \$\d/);
    expect(clientRead().params).toContain(ORG_A);
  });

  test('preparing for a foreign client writes no draft', async () => {
    mockResponder = world({ owned: false });
    const res = await prepare();
    expect(res.status).toBe(404);
    expect(draftInsert()).toBeUndefined();
  });

  test('the draft is stamped with the caller\'s own org', async () => {
    await prepare();
    expect(draftInsert().params[0]).toBe(ORG_A);
  });

  test('the claim is keyed on org AND creator, not the id alone', async () => {
    await confirm();
    expect(draftClaim().sql).toMatch(/AND organization_id = \$2/);
    expect(draftClaim().sql).toMatch(/AND created_by = \$3/);
    expect(draftClaim().params).toEqual([DRAFT_ID, ORG_A, 'u-a']);
  });

  test('confirming another studio\'s draft records nothing', async () => {
    mockUser = ADMIN_B;
    mockResponder = world({ claim: [] });
    const res = await confirm();
    expect(res.status).toBe(409);
    expect(ledgerInsert()).toBeUndefined();
    expect(balanceMove()).toBeUndefined();
  });

  test('a colleague cannot confirm someone else\'s payment draft', async () => {
    mockUser = OTHER_A;
    mockResponder = world({ claim: [] });
    const res = await confirm();
    expect(res.status).toBe(409);
    expect(draftClaim().params[2]).toBe('u-a2');
  });

  test('a client that changed org between prepare and confirm is refused', async () => {
    mockResponder = world({ client: { ...CLIENT, organization_id: ORG_B } });
    const res = await confirm();
    expect(res.status).toBe(404);
    expect(ledgerInsert()).toBeUndefined();
    expect(q(/^ROLLBACK$/i)).toBeDefined();
  });

  test('an org-less caller cannot record a payment at all', async () => {
    mockUser = ORPHAN;
    const res = await prepare();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_ORGANIZATION');
    expect(draftInsert()).toBeUndefined();
  });
});

// ── E. Preparing records nothing ──────────────────────────────────────────
describe('E. prepare never records a payment', () => {
  test('it writes a draft and no ledger row', async () => {
    const res = await prepare();
    expect(res.status).toBe(201);
    expect(res.body.recorded).toBe(false);
    expect(ledgerInsert()).toBeUndefined();
    expect(balanceMove()).toBeUndefined();
  });

  test('it asks the question the brief specifies', async () => {
    const res = await prepare();
    expect(res.body.spoken).toBe('Record 3,000 rupees payment for Rahul?');
  });

  test('it reports the amount and the balance before it', async () => {
    const res = await prepare();
    expect(res.body.amount).toBe(3000);
    expect(res.body.outstanding_before).toBe(5000);
  });
});

// ── F. Amount validation ──────────────────────────────────────────────────
describe('F. the amount is validated', () => {
  test.each([[0], [-1], [-3000]])('%p is rejected', async (amount) => {
    const res = await prepare({ client_id: CLIENT_ID, amount });
    expect(res.status).toBe(400);
    expect(draftInsert()).toBeUndefined();
  });

  test('an absurd amount is rejected, not clamped', async () => {
    const res = await prepare({ client_id: CLIENT_ID, amount: 99_000_000 });
    expect(res.status).toBe(400);
  });

  test('a non-numeric amount is rejected', async () => {
    expect((await prepare({ client_id: CLIENT_ID, amount: 'three thousand' })).status).toBe(400);
  });

  test('a missing amount is rejected', async () => {
    expect((await prepare({ client_id: CLIENT_ID })).status).toBe(400);
  });

  test('more than two decimal places is rejected, not silently rounded', async () => {
    const res = await prepare({ client_id: CLIENT_ID, amount: 3000.567 });
    expect(res.status).toBe(400);
  });

  test('two decimal places are accepted and spoken as paise', async () => {
    const res = await prepare({ client_id: CLIENT_ID, amount: 2500.5 });
    expect(res.status).toBe(201);
    expect(res.body.spoken).toContain('2,500 rupees 50 paise');
  });

  test('an unknown payment method is rejected', async () => {
    expect((await prepare({ client_id: CLIENT_ID, amount: 100, method: 'CRYPTO' })).status).toBe(400);
  });

  test('a malformed client id never reaches the database', async () => {
    const res = await prepare({ client_id: 'ptc/../x', amount: 100 });
    expect(res.status).toBe(400);
    expect(mockLog).toHaveLength(0);
  });
});

// ── G. Confirmation bypass ────────────────────────────────────────────────
describe('G. the amount cannot travel back from the phone', () => {
  test('confirm rejects an amount field outright', async () => {
    const res = await confirm({ draft_id: DRAFT_ID, amount: 999999 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(ledgerInsert()).toBeUndefined();
  });

  test('confirm rejects a client_id field', async () => {
    expect((await confirm({ draft_id: DRAFT_ID, client_id: 'ptc-other' })).status).toBe(400);
  });

  test('confirm rejects a method field', async () => {
    expect((await confirm({ draft_id: DRAFT_ID, method: 'CASH' })).status).toBe(400);
  });

  test('the amount recorded is the DRAFT\'s, whatever was sent', async () => {
    await confirm();
    // pt_payments INSERT: $4 is amount
    expect(Number(ledgerInsert().params[3])).toBe(3000);
  });

  test('the balance moves by the draft\'s amount', async () => {
    await confirm();
    expect(Number(balanceMove().params[0])).toBe(3000);
  });

  test('a malformed draft id never reaches the database', async () => {
    const res = await confirm({ draft_id: 'nope' });
    expect(res.status).toBe(400);
    expect(draftClaim()).toBeUndefined();
  });
});

// ── H. Duplicate and replayed transactions ────────────────────────────────
describe('H. duplicates and replays', () => {
  test('the claim requires a pending, unexpired draft', async () => {
    await confirm();
    expect(draftClaim().sql).toMatch(/AND status = 'pending'/);
    expect(draftClaim().sql).toMatch(/AND expires_at > NOW\(\)/);
  });

  test('the claim happens BEFORE any money moves', async () => {
    await confirm();
    expect(mockLog.indexOf(draftClaim())).toBeLessThan(mockLog.indexOf(ledgerInsert()));
  });

  test('a replayed confirmation records nothing', async () => {
    mockResponder = world({ claim: [] });
    const res = await confirm();
    expect(res.status).toBe(409);
    expect(res.body.recorded).toBe(false);
    expect(ledgerInsert()).toBeUndefined();
    expect(balanceMove()).toBeUndefined();
    expect(q(/^COMMIT$/i)).toBeUndefined();
  });

  test('a replay says to start again rather than claiming success', async () => {
    mockResponder = world({ claim: [] });
    const res = await confirm();
    expect(res.body.spoken).toMatch(/start it again/i);
    expect(res.body.spoken).not.toMatch(/^Done/);
  });

  test('the client row is LOCKED before the ledger is touched', async () => {
    await confirm();
    expect(lockQuery()).toBeDefined();
    expect(mockLog.indexOf(lockQuery())).toBeLessThan(mockLog.indexOf(ledgerInsert()));
  });

  test('an identical recent payment is surfaced at prepare time', async () => {
    mockResponder = world({
      duplicate: [{ id: 'pay-1', amount: '3000.00', created_at: new Date(Date.now() - 120e3).toISOString() }],
    });
    const res = await prepare();
    expect(res.body.recent_duplicate).toMatchObject({ amount: 3000, minutes_ago: 2 });
  });

  test('and is spoken BEFORE the question, since it is why one would say no', async () => {
    mockResponder = world({
      duplicate: [{ id: 'pay-1', amount: '3000.00', created_at: new Date(Date.now() - 120e3).toISOString() }],
    });
    const res = await prepare();
    const spoken = res.body.spoken;
    expect(spoken).toMatch(/^I already recorded 3,000 rupees for Rahul 2 minutes ago\./);
    expect(spoken).toMatch(/Record 3,000 rupees payment for Rahul\?$/);
    expect(spoken.indexOf('already recorded')).toBeLessThan(spoken.indexOf('Record 3,000'));
  });

  test('the duplicate window is bounded, not the whole ledger', async () => {
    await prepare();
    expect(dupQuery().sql).toMatch(/created_at > NOW\(\) - \(\$3 \|\| ' minutes'\)::interval/);
  });

  test('a duplicate check failure does not block a legitimate payment', async () => {
    mockResponder = (sql) => {
      if (/AND amount = \$2 AND created_at > NOW\(\)/i.test(sql)) throw new Error('timeout');
      return world()(sql);
    };
    const res = await prepare();
    expect(res.status).toBe(201);
    expect(res.body.recent_duplicate).toBeNull();
  });
});

// ── I. It uses the app's own payment logic ────────────────────────────────
describe('I. the existing payment service', () => {
  test('a confirmed payment writes the ledger row and moves the balance', async () => {
    const res = await confirm();
    expect(res.status).toBe(201);
    expect(ledgerInsert()).toBeDefined();
    expect(balanceMove()).toBeDefined();
    expect(q(/^COMMIT$/i)).toBeDefined();
  });

  test('both happen inside ONE transaction', async () => {
    await confirm();
    const begin = mockLog.findIndex((x) => /^BEGIN$/i.test(x.sql));
    const commit = mockLog.findIndex((x) => /^COMMIT$/i.test(x.sql));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(mockLog.indexOf(ledgerInsert())).toBeGreaterThan(begin);
    expect(mockLog.indexOf(balanceMove())).toBeLessThan(commit);
  });

  test('a receipt number is generated, as the finance UI does', async () => {
    await confirm();
    expect(ledgerInsert().params).toContain('RCP-20260822-100001');
  });

  test('the trainer incentive is computed, not skipped', async () => {
    await confirm();
    // $5 is incentive_amt — 50% of 3000 by the stubbed rate.
    expect(Number(ledgerInsert().params[4])).toBe(1500);
  });

  test('the payment is stamped with the CLIENT\'s org, not a request value', async () => {
    await confirm();
    expect(ledgerInsert().params[9]).toBe(ORG_A);
  });

  test('the payment date is the studio\'s today', async () => {
    await confirm();
    expect(ledgerInsert().params[7]).toBe(studioToday());
  });

  test('the balance never goes negative on an overpayment', async () => {
    await confirm();
    expect(balanceMove().sql).toMatch(/GREATEST\(0, balance_amount - \$1\)/);
  });

  test('it reports the receipt and what is left', async () => {
    const res = await confirm();
    expect(res.body.recorded).toBe(true);
    expect(res.body.receipt_no).toBe('RCP-20260822-100001');
    expect(res.body.outstanding_after).toBe(2000);
    expect(res.body.spoken).toBe('Done. 3,000 rupees recorded for Rahul. 2,000 rupees still outstanding.');
  });

  test('a fully settled client is told so', async () => {
    mockResponder = world({ client: { ...CLIENT, balance_amount: '3000.00' } });
    const res = await confirm();
    expect(res.body.outstanding_after).toBe(0);
    expect(res.body.spoken).toMatch(/Nothing outstanding now\.$/);
  });
});

// ── J. Audit ──────────────────────────────────────────────────────────────
describe('J. audit', () => {
  const auditActions = () => mockLog
    .filter((x) => /INSERT INTO activity_log/i.test(x.sql))
    .flatMap((x) => x.params.filter((p) => typeof p === 'string' && p.startsWith('voice.')));

  test('checking a balance is audited', async () => {
    await status();
    expect(auditActions()).toContain('voice.payments.status');
  });

  test('preparing is audited with the amount', async () => {
    await prepare();
    expect(auditActions()).toContain('voice.payments.prepare');
    const row = mockLog.filter((x) => /INSERT INTO activity_log/i.test(x.sql))
      .find((x) => x.params.includes('voice.payments.prepare'));
    const payload = row.params.filter((v) => typeof v === 'string' && v.startsWith('{'))
      .map((v) => JSON.parse(v)).find((o) => o.channel === 'voice');
    expect(payload).toMatchObject({ client_id: CLIENT_ID, amount: 3000, method: 'CASH' });
  });

  test('a recorded payment is audited with its receipt', async () => {
    await confirm();
    const row = mockLog.filter((x) => /INSERT INTO activity_log/i.test(x.sql))
      .find((x) => x.params.includes('voice.payments.confirm'));
    const payload = row.params.filter((v) => typeof v === 'string' && v.startsWith('{'))
      .map((v) => JSON.parse(v)).find((o) => o.channel === 'voice');
    expect(payload).toMatchObject({
      client_id: CLIENT_ID, amount: 3000, receipt_no: 'RCP-20260822-100001',
    });
  });

  test('the audit row is written AFTER the commit', async () => {
    await confirm();
    const commit = mockLog.findIndex((x) => /^COMMIT$/i.test(x.sql));
    const audit = mockLog.findIndex((x) => /INSERT INTO activity_log/i.test(x.sql)
      && x.params.includes('voice.payments.confirm'));
    expect(audit).toBeGreaterThan(commit);
  });

  test('a rejected confirmation is audited too', async () => {
    mockResponder = world({ claim: [] });
    await confirm();
    expect(auditActions()).toContain('voice.payments.confirm.rejected');
  });
});
