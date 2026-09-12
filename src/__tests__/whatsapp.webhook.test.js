// The WhatsApp gateway webhook receiver.
//
// Three properties are load-bearing here, and each has a concrete failure when
// it is wrong:
//
//   signature   — an unsigned endpoint on the public app lets anyone flip a
//                 studio's WhatsApp status, or mark it connected when it is not
//   replay      — without a timestamp window, a captured `connected` replays
//                 forever
//   idempotency — the gateway delivers at-least-once, so a redelivered
//                 `disconnected` would overwrite a later `connected` and show a
//                 working studio as offline

const crypto = require('crypto');

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.WA_WEBHOOK_SECRET = 'test-webhook-secret-at-least-32-characters!';

// The handler claims the idempotency ledger and applies the event on ONE
// transaction now, so the mock has to hand out a client. It delegates to the
// same query mock every assertion below already reads, and records BEGIN /
// COMMIT / ROLLBACK so the transaction itself can be asserted — which is the
// property that stops a failed apply from keeping its claim.
jest.mock('../db/pool', () => {
  const query = jest.fn();
  const txn = [];
  const client = {
    query: jest.fn((sql, params) => {
      const verb = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (verb === 'BEGIN' || verb === 'COMMIT' || verb === 'ROLLBACK') {
        txn.push(verb);
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return query(sql, params);
    }),
    release: jest.fn(),
  };
  return { query, connect: jest.fn(async () => client), __client: client, __txn: txn };
});

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const webhookRouter = require('../routes/whatsapp-webhook');

// Mounted WITHOUT express.json(), exactly as server.js does. If this test
// mounted a JSON parser first it would prove the opposite of what it claims:
// the router's own express.raw() must be what reads the body.
const app = express();
app.use('/api/webhooks/whatsapp', webhookRouter);

const ORG = '11111111-1111-4111-8111-111111111111';
const INSTANCE = '3b7e0000-0000-4000-8000-000000000002';
const SECRET = process.env.WA_WEBHOOK_SECRET;

function makeEvent(overrides = {}) {
  return {
    schema_version: 1,
    event_id: crypto.randomUUID(),
    event_type: 'whatsapp.instance.connected',
    instance_id: INSTANCE,
    tenant_id: ORG,
    occurred_at: new Date().toISOString(),
    payload: { phone_e164: '+919876543210', connected_at: new Date().toISOString() },
    ...overrides,
  };
}

function sign(body, secret = SECRET, tsSec = Math.floor(Date.now() / 1000)) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const signature =
    'sha256=' + crypto.createHmac('sha256', secret).update(`${tsSec}.${raw}`, 'utf8').digest('hex');
  return { raw, signature, timestamp: String(tsSec) };
}

function post(body, opts = {}) {
  const { raw, signature, timestamp } = sign(body, opts.secret, opts.tsSec);
  const req = request(app)
    .post('/api/webhooks/whatsapp')
    .set('Content-Type', 'application/json');

  if (opts.signature !== null) req.set('x-wa-signature', opts.signature ?? signature);
  if (opts.timestamp !== null) req.set('x-wa-timestamp', opts.timestamp ?? timestamp);

  return req.send(opts.rawOverride ?? raw);
}

/** Default: the idempotency claim succeeds and the update applies. */
beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rowCount: 1, rows: [] });
});

describe('signature verification', () => {
  it('accepts a correctly signed event', async () => {
    const res = await post(makeEvent());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true });
  });

  it('rejects an unsigned request', async () => {
    const res = await post(makeEvent(), { signature: null });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a wrong signature and touches nothing', async () => {
    const res = await post(makeEvent(), { signature: 'sha256=' + 'a'.repeat(64) });
    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a signature made with a different secret', async () => {
    const res = await post(makeEvent(), { secret: 'a-completely-different-secret-0123456789ab' });
    expect(res.status).toBe(401);
  });

  it('rejects a tampered body', async () => {
    // The whole point of signing: the signature is computed over the original
    // bytes, so changing the state after signing invalidates it.
    const event = makeEvent();
    const { raw, signature, timestamp } = sign(event);
    const tampered = raw.replace('connected', 'logged_out');

    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('x-wa-signature', signature)
      .set('x-wa-timestamp', timestamp)
      .send(tampered);

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('does not throw on a signature of the wrong length', async () => {
    // Raw timingSafeEqual throws on a length mismatch; hashing both sides first
    // is what makes this a 401 rather than a 500.
    for (const bad of ['x', 'sha256=deadbeef', 'y'.repeat(500)]) {
      const res = await post(makeEvent(), { signature: bad });
      expect(res.status).toBe(401);
    }
  });

  it('fails closed when the secret is not configured', async () => {
    // A half-configured deploy answering "fine" to an unverifiable claim is
    // worse than an outage — same rule as middleware/serviceAuth.js.
    const saved = process.env.WA_WEBHOOK_SECRET;
    delete process.env.WA_WEBHOOK_SECRET;
    try {
      const res = await post(makeEvent());
      expect(res.status).toBe(503);
      expect(pool.query).not.toHaveBeenCalled();
    } finally {
      process.env.WA_WEBHOOK_SECRET = saved;
    }
  });
});

describe('replay protection', () => {
  it('rejects an event stamped outside the window', async () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    const res = await post(makeEvent(), { tsSec: old });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects an event stamped too far in the future', async () => {
    // Rejecting only the past would let a future-stamped capture replay once
    // the clock caught up.
    const ahead = Math.floor(Date.now() / 1000) + 301;
    const res = await post(makeEvent(), { tsSec: ahead });
    expect(res.status).toBe(400);
  });

  it('accepts an event inside the window', async () => {
    const recent = Math.floor(Date.now() / 1000) - 120;
    const res = await post(makeEvent(), { tsSec: recent });
    expect(res.status).toBe(200);
  });

  it('cannot be replayed by rewriting only the timestamp header', async () => {
    // The attack the binding defends against: take a valid old request and
    // change the timestamp so it looks fresh. The signature covered the OLD
    // timestamp, so it no longer matches.
    const event = makeEvent();
    const old = Math.floor(Date.now() / 1000) - 400;
    const { raw, signature } = sign(event, SECRET, old);

    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('x-wa-signature', signature)
      .set('x-wa-timestamp', String(Math.floor(Date.now() / 1000)))
      .send(raw);

    expect(res.status).toBe(401);
  });

  it('rejects a malformed timestamp rather than coercing it', async () => {
    // parseInt would read '1788000000abc' as valid, and Number('') is 0 — a
    // plausible-looking epoch in 1970.
    for (const bad of ['abc', '1788000000abc', '-1', '17.88', '']) {
      const res = await post(makeEvent(), { timestamp: bad });
      expect([400]).toContain(res.status);
    }
  });
});

describe('idempotency', () => {
  it('applies a first-seen event', async () => {
    const res = await post(makeEvent());
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBeUndefined();

    const sql = pool.query.mock.calls.map(([q]) => q).join('\n');
    expect(sql).toMatch(/INSERT INTO whatsapp_webhook_events/i);
    expect(sql).toMatch(/UPDATE whatsapp_instances/i);
  });

  it('acknowledges a duplicate WITHOUT re-applying it', async () => {
    // The failure this prevents: a redelivered `disconnected` overwriting a
    // `connected` that arrived after it, showing a working studio as offline.
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ledger conflict

    const res = await post(makeEvent());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: true });
    // Exactly one query: the claim. No UPDATE followed it.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('answers 200 for a duplicate so the gateway stops retrying', async () => {
    // A duplicate IS success from the sender's point of view; any non-2xx
    // would make the gateway retry it until it dead-letters.
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await post(makeEvent());
    expect(res.status).toBe(200);
  });

  // ── The claim is worthless unless the work goes with it ──────────────────
  //
  // These two ran as separate autocommitted statements, claim first. So a
  // failure AFTER the claim lost the event permanently: the 500 asked the
  // gateway to retry, and the retry hit ON CONFLICT and was answered
  // "duplicate" without ever applying anything. The studio's message simply
  // never reached delivered, and no error anywhere said why.
  //
  // Production had four sent WhatsApp messages, six delivery receipts and zero
  // delivered_at. The receipts were historical — the applying code was not yet
  // deployed when they arrived, and the join is sound today — but the hole that
  // would have swallowed them silently is real, and this is it.

  it('runs the claim and the work in ONE transaction', async () => {
    pool.__txn.length = 0;
    await post(makeEvent());
    // BEGIN before the claim, COMMIT after the work. Not two autocommits.
    expect(pool.__txn[0]).toBe('BEGIN');
    expect(pool.__txn).toContain('COMMIT');
    expect(pool.__txn).not.toContain('ROLLBACK');
  });

  it('rolls the claim BACK when applying the event fails', async () => {
    pool.__txn.length = 0;
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })              // claim taken
      .mockRejectedValueOnce(new Error('deadlock detected'));         // the work fails

    const res = await post(makeEvent());

    // 500 asks the gateway to retry — and the rollback is what makes that
    // honest, because the retry now finds no claim and applies for real.
    expect(res.status).toBe(500);
    expect(pool.__txn).toContain('ROLLBACK');
    expect(pool.__txn).not.toContain('COMMIT');
  });

  it('releases the connection even when the work throws', async () => {
    // A leaked client per failed webhook exhausts the pool, and the gateway
    // retries on failure — so the leak compounds exactly when it hurts most.
    pool.__client.release.mockClear();
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockRejectedValueOnce(new Error('boom'));

    await post(makeEvent());
    expect(pool.__client.release).toHaveBeenCalled();
  });

  it('does not hold a transaction open for a duplicate', async () => {
    pool.__txn.length = 0;
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await post(makeEvent());
    expect(pool.__txn).toContain('ROLLBACK');
    expect(pool.__txn).not.toContain('COMMIT');
  });

  it('claims atomically with ON CONFLICT rather than select-then-insert', async () => {
    // Two concurrent redeliveries would both see "not present" with a
    // select-then-insert and both apply the update.
    await post(makeEvent());
    const claim = pool.query.mock.calls[0][0];
    expect(claim).toMatch(/ON CONFLICT \(event_id\) DO NOTHING/i);
  });
});

describe('applying events', () => {
  it('maps each event type to the right status', async () => {
    const cases = [
      ['whatsapp.instance.connected', 'connected'],
      ['whatsapp.instance.disconnected', 'disconnected'],
      ['whatsapp.instance.logged_out', 'logged_out'],
      ['whatsapp.instance.qr', 'connecting'],
      ['whatsapp.instance.connecting', 'connecting'],
      ['whatsapp.instance.created', 'never_connected'],
    ];

    // Collected and compared in one go: Jest's expect() takes no message
    // argument, so a per-iteration assertion would fail without saying WHICH
    // event type broke.
    const observed = [];
    for (const [eventType] of cases) {
      pool.query.mockReset();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [] });

      await post(makeEvent({ event_type: eventType }));

      const update = pool.query.mock.calls.find(([q]) => /UPDATE whatsapp_instances/i.test(q));
      observed.push([eventType, update ? update[1][2] : undefined]);
    }
    expect(observed).toEqual(cases);
  });

  it('acknowledges an unknown event type without changing anything', async () => {
    // The gateway may ship a new event type before this deploy does. Retrying
    // something we will never understand only fills the dead-letter list.
    await post(makeEvent({ event_type: 'whatsapp.message.received' }));

    const updates = pool.query.mock.calls.filter(([q]) => /UPDATE whatsapp_instances/i.test(q));
    expect(updates).toHaveLength(0);
  });

  it('scopes the update by BOTH instance and organization', async () => {
    // The gateway is trusted here — it holds the signing secret — but scoping
    // costs nothing and means a gateway bug cannot rewrite another studio's row.
    await post(makeEvent());
    const update = pool.query.mock.calls.find(([q]) => /UPDATE whatsapp_instances/i.test(q));
    expect(update[0]).toMatch(/WHERE instance_id = \$1/);
    expect(update[0]).toMatch(/AND organization_id = \$2/);
    expect(update[1][0]).toBe(INSTANCE);
    expect(update[1][1]).toBe(ORG);
  });

  it('refuses to move an instance backwards in time', async () => {
    // At-least-once delivery plus independent retry backoff means events can
    // arrive out of order. Without the last_event_at guard a retried
    // `disconnected` landing after the `connected` that superseded it would
    // show a working studio as offline, with nothing to correct it until the
    // next real transition.
    await post(makeEvent());
    const update = pool.query.mock.calls.find(([q]) => /UPDATE whatsapp_instances/i.test(q));
    expect(update[0]).toMatch(/last_event_at IS NULL OR last_event_at <=/);
  });

  it('reports applied: false when the row was already newer', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // ledger claim
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // superseded

    const res = await post(makeEvent());
    // 200, not an error: being superseded is a correct outcome, not something
    // to retry.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, applied: false });
  });

  it('rejects a malformed envelope', async () => {
    for (const bad of [{}, { event_id: 'x' }, makeEvent({ tenant_id: undefined })]) {
      pool.query.mockReset();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [] });
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect(pool.query).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid JSON that is nonetheless correctly signed', async () => {
    const res = await post('not json at all');
    expect(res.status).toBe(400);
  });

  it('answers 500 on a database failure so the gateway retries', async () => {
    // The gateway's outbox is durable and bounded, so a database blip delays
    // the update rather than losing it.
    pool.query.mockRejectedValueOnce(new Error('connection terminated'));
    const res = await post(makeEvent());
    expect(res.status).toBe(500);
  });
});

// ── Message lifecycle events ────────────────────────────────────────────────
//
// These are the delivery callbacks. They update communication_logs rather than
// whatsapp_instances, and they are the reason that table has separate
// delivered_at and read_at columns — which, until the automation engine
// existed, nothing had ever written.
describe('what the ledger records about an event', () => {
  // ── The production question this exists to answer ─────────────────────────
  //
  // Measured on the live database: 6 `whatsapp.message.delivered` events
  // received, verified, claimed and answered 200 — and 0 communication_logs
  // rows with delivered_at set. Two completely different explanations, and the
  // ledger could not separate them.
  //
  // Either those receipts were the studio's OWN hand-sent messages (the
  // gateway forwards a receipt for every message the account sent, and
  // `fromMe` is true for one the trainer typed on their phone), in which case
  // they correctly matched nothing. Or the provider id on a receipt does not
  // match the external_id recorded at send time, and every delivery receipt
  // this product will ever receive is being silently discarded.
  //
  // The first is fine. The second means the delivery-state UI never populates.
  // Telling them apart needed the id the event carried and the number of rows
  // it changed, stored next to the claim that proves it was not a replay.

  const ledgerWrites = () =>
    pool.query.mock.calls
      .filter(([sql]) => /UPDATE whatsapp_webhook_events/.test(sql))
      .map(([sql, params]) => ({ sql: sql.replace(/\s+/g, ' ').trim(), params }));

  test('a receipt that matched nothing is recorded as matching nothing', async () => {
    // applied_rows = 0 is the whole point. It is a real outcome, not an
    // absence of one, and it must survive log retention.
    pool.query.mockImplementation(async (sql) => {
      if (/UPDATE communication_logs/.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const res = await post(makeEvent({
      event_type: 'whatsapp.message.delivered',
      payload: { provider_message_id: 'WAMSG-NOBODY' },
    }));

    expect(res.status).toBe(200);
    const [write] = ledgerWrites();
    expect(write.params[1]).toBe('WAMSG-NOBODY');
    expect(write.params[2]).toBe(0);
  });

  test('a receipt that landed records the row it changed', async () => {
    const res = await post(makeEvent({
      event_type: 'whatsapp.message.read',
      payload: { provider_message_id: 'WAMSG1' },
    }));

    expect(res.status).toBe(200);
    expect(ledgerWrites()[0].params).toEqual([expect.any(String), 'WAMSG1', 1]);
  });

  test('an inert sent event still records WHICH message it was about', async () => {
    // `sent` changes nothing by design. Recording its provider id anyway is
    // what makes a later unmatched receipt diagnosable: the id the gateway
    // sent under, and the id a receipt came looking for, in two rows of one
    // table.
    await post(makeEvent({
      event_type: 'whatsapp.message.sent',
      payload: { client_message_id: 'log-1', provider_message_id: 'WAMSG1' },
    }));

    const [write] = ledgerWrites();
    expect(write.params[1]).toBe('WAMSG1');
    expect(write.params[2]).toBe(0);
  });

  test('the outcome commits with the work it describes, in the same transaction', async () => {
    // Written through the transaction client, not the pool. Otherwise the
    // ledger could claim an event applied a row that was rolled back.
    pool.__txn.length = 0;
    pool.__client.query.mockClear();

    await post(makeEvent({
      event_type: 'whatsapp.message.delivered',
      payload: { provider_message_id: 'WAMSG1' },
    }));

    const onClient = pool.__client.query.mock.calls
      .filter(([sql]) => typeof sql === 'string' && /UPDATE whatsapp_webhook_events/.test(sql));
    expect(onClient).toHaveLength(1);
    expect(pool.__txn).toContain('COMMIT');
  });

  test('a connection event records the instance and whether it was superseded', async () => {
    // An out-of-order event that lost the last_event_at guard applies 0 rows.
    // That is the same "genuine but changed nothing" outcome a stray receipt
    // has, and it is worth the same record.
    pool.query.mockImplementation(async (sql) => {
      if (/UPDATE whatsapp_instances/.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    await post(makeEvent());

    const [write] = ledgerWrites();
    expect(write.params[1]).toBe(INSTANCE);
    expect(write.params[2]).toBe(0);
  });

  test('a failure to record the outcome never fails the webhook', async () => {
    // This is observability. A webhook that answered 500 because it could not
    // write a diagnostic column would ask the gateway to redeliver an event it
    // had already applied — turning the thing meant to explain a problem into
    // one.
    pool.query.mockImplementation(async (sql) => {
      if (/UPDATE whatsapp_webhook_events/.test(sql)) throw new Error('column does not exist');
      return { rowCount: 1, rows: [] };
    });

    const res = await post(makeEvent({
      event_type: 'whatsapp.message.delivered',
      payload: { provider_message_id: 'WAMSG1' },
    }));

    expect(res.status).toBe(200);
  });

  test('a duplicate writes no outcome at all', async () => {
    // It did no work, so it has no outcome — and overwriting the original
    // event's applied_rows with a replay's zero would erase the answer.
    pool.query.mockImplementation(async (sql) => {
      if (/INSERT INTO whatsapp_webhook_events/.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const res = await post(makeEvent({
      event_type: 'whatsapp.message.delivered',
      payload: { provider_message_id: 'WAMSG1' },
    }));

    expect(res.body).toMatchObject({ duplicate: true });
    expect(ledgerWrites()).toHaveLength(0);
  });
});

describe('delivery receipts', () => {
  /** Every UPDATE communication_logs this request issued. */
  const logUpdates = () =>
    pool.query.mock.calls
      .filter(([sql]) => /UPDATE communication_logs/.test(sql))
      .map(([sql, params]) => ({ sql: sql.replace(/\s+/g, ' ').trim(), params }));

  test('a delivered receipt is matched on the provider message id', async () => {
    // Keyed by the PROVIDER's id, because WhatsApp's own receipts arrive that
    // way. The ERP stored it in external_id when it processed the send.
    const res = await post(makeEvent({
      event_type: 'whatsapp.message.delivered',
      payload: { provider_message_id: 'WAMSG1', delivered_at: '2026-09-09T10:00:00.000Z' },
    }));

    expect(res.status).toBe(200);
    const [update] = logUpdates();
    expect(update.params[0]).toBe('WAMSG1');
    expect(update.params[2]).toBe('delivered');
  });

  test('every receipt is bound to the tenant on the signed envelope', async () => {
    // The HMAC makes forgery hard; this makes it ineffective. An event naming
    // another studio's message id updates nothing.
    await post(makeEvent({
      event_type: 'whatsapp.message.read',
      payload: { provider_message_id: 'WAMSG1', read_at: '2026-09-09T10:05:00.000Z' },
    }));
    expect(logUpdates()[0].params[1]).toBe(ORG);
  });

  test('a failure is matched on the id the ERP itself minted', async () => {
    // At the moment a send fails there is no provider id — nothing was
    // accepted — so client_message_id is the only id both sides share.
    await post(makeEvent({
      event_type: 'whatsapp.message.failed',
      payload: { client_message_id: 'log-1', reason_code: 'send_failed', will_retry: true },
    }));
    const [update] = logUpdates();
    expect(update.params).toEqual(['log-1', ORG, 'send_failed']);
  });

  test('a sent event changes nothing, because the worker already recorded it', async () => {
    // The worker wrote the row synchronously from the HTTP response, which
    // carried the same provider id, and did so before this event could arrive.
    // Applying it again could pull a delivered row back to 'sent'.
    const res = await post(makeEvent({
      event_type: 'whatsapp.message.sent',
      payload: { client_message_id: 'log-1', provider_message_id: 'WAMSG1', sent_at: new Date().toISOString() },
    }));
    expect(res.status).toBe(200);
    expect(logUpdates()).toHaveLength(0);
  });

  test('a receipt never touches whatsapp_instances', async () => {
    // A message event is not a connection event. Routing one through the
    // instance status table would move a studio's connection state on the
    // strength of a delivery receipt.
    await post(makeEvent({
      event_type: 'whatsapp.message.delivered',
      payload: { provider_message_id: 'WAMSG1' },
    }));
    const touched = pool.query.mock.calls.map(([sql]) => sql).join(' ');
    expect(touched).not.toMatch(/UPDATE whatsapp_instances/);
  });

  test('a receipt with no ids is acknowledged and applied to nothing', async () => {
    // Answering non-2xx would make the gateway retry an event that can never
    // match, which only fills the dead-letter list.
    const res = await post(makeEvent({
      event_type: 'whatsapp.message.delivered',
      payload: {},
    }));
    expect(res.status).toBe(200);
    expect(logUpdates()).toHaveLength(0);
  });

  test('receipts still go through the idempotency ledger', async () => {
    // The gateway delivers at-least-once for message events too.
    pool.query.mockReset();
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // claim refused
    const res = await post(makeEvent({
      event_type: 'whatsapp.message.delivered',
      payload: { provider_message_id: 'WAMSG1' },
    }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ duplicate: true });
    expect(logUpdates()).toHaveLength(0);
  });
});
