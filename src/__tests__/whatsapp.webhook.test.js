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

jest.mock('../db/pool', () => ({ query: jest.fn() }));

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
