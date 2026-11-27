// Sending from the trainer's inbox, over either channel.
//
// The ordering is the design: validate the channel and the phone BEFORE
// inserting, because a row inserted for a send that cannot happen becomes a
// message the member never receives and the trainer cannot retry. The thread
// row id is the gateway's idempotency key, so a retry of the same row cannot
// double-send.
//
// Notifications are asserted through the SQL notifyOnce issues: notifyOnce is
// private to the module under test, and spying on it would test the spy rather
// than the notification.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../modules/messaging/transport', () => ({ resolveInstance: jest.fn(), send: jest.fn() }));

const pool = require('../db/pool');
const transport = require('../modules/messaging/transport');
const {
  studioSend, retryWhatsApp,
} = require('../modules/client-messages/client-messages.service');

const ORG = '11111111-1111-4111-8111-111111111111';
const client = {
  id: 'c1', name: 'Ravi', whatsapp: '9876543210', mobile: '9876543210', member_user_id: 'mu1',
};

let db;
beforeEach(() => {
  db = {
    lastChannel: null,
    row: null,
    insertSql: undefined,
    insertParams: undefined,
    queries: [],
  };

  pool.query.mockReset();
  pool.query.mockImplementation(async (sql, params = []) => {
    db.queries.push({ sql, params });

    if (/INSERT INTO notifications/i.test(sql)) return { rows: [], rowCount: 1 };

    if (/INSERT INTO client_messages/i.test(sql)) {
      db.insertSql = sql;
      db.insertParams = params;
      return {
        rows: [{
          id: 'm1',
          sender: 'studio',
          body: params[4],
          read_at: null,
          created_at: '2026-11-26T10:00:00.000Z',
          channel: params[5],
          message_type: params[6],
          delivery_status: params[8],
          failure_reason: null,
        }],
        rowCount: 1,
      };
    }

    if (/SELECT channel FROM client_messages/i.test(sql)) {
      return {
        rows: db.lastChannel ? [{ channel: db.lastChannel }] : [],
        rowCount: db.lastChannel ? 1 : 0,
      };
    }

    if (/SELECT .*FROM client_messages/i.test(sql)) {
      return { rows: db.row ? [db.row] : [], rowCount: db.row ? 1 : 0 };
    }

    if (/UPDATE client_messages/i.test(sql)) {
      const base = db.row || { id: 'm1', body: 'Hi', channel: 'whatsapp' };
      if (/delivery_status = 'sent'/i.test(sql)) {
        if (db.sentMiss) return { rows: [], rowCount: 0 };
        return { rows: [{ ...base, delivery_status: 'sent', external_id: params[2] }], rowCount: 1 };
      }
      if (/delivery_status = 'failed'/i.test(sql)) {
        return { rows: [{ ...base, delivery_status: 'failed', failure_reason: params[2] }], rowCount: 1 };
      }
      return { rows: [{ ...base, delivery_status: 'queued' }], rowCount: 1 };
    }

    throw new Error(`unexpected query: ${sql}`);
  });

  transport.resolveInstance.mockReset();
  transport.resolveInstance.mockResolvedValue({ ok: false, reason: 'not_connected' });
  transport.send.mockReset();
});

const notificationQuery = () =>
  db.queries.find(({ sql }) => /INSERT INTO notifications/i.test(sql));

it('defaults an in-app reply and notifies the member', async () => {
  const { message, delivery } = await studioSend(ORG, client, 'u1', 'Hello', { senderName: 'Coach Asha' });

  expect(delivery).toEqual({ ok: true, status: 'in_app' });
  expect(db.insertParams.slice(5, 7)).toEqual(['in_app', 'text']);
  expect(message.delivery_status).toBeNull();
  expect(notificationQuery().params).toEqual([
    'mu1', 'New message from Coach Asha', 'Hello', '/member/messages',
  ]);
});

it('refuses WhatsApp before inserting when the client has no number', async () => {
  await expect(studioSend(
    ORG, { ...client, whatsapp: null, mobile: null }, 'u1', 'Hi', { channel: 'whatsapp' },
  )).rejects.toMatchObject({ status: 409, code: 'NO_PHONE' });

  expect(db.insertSql).toBeUndefined();
});

it('refuses WhatsApp before inserting when the studio is disconnected', async () => {
  transport.resolveInstance.mockResolvedValue({ ok: false, reason: 'not_connected' });

  await expect(studioSend(ORG, client, 'u1', 'Hi', { channel: 'whatsapp' }))
    .rejects.toMatchObject({ status: 409, code: 'CHANNEL_UNAVAILABLE' });

  expect(db.insertSql).toBeUndefined();
});

it('rejects an unknown channel rather than guessing one', async () => {
  await expect(studioSend(ORG, client, 'u1', 'Hi', { channel: 'sms' }))
    .rejects.toMatchObject({ status: 400, code: 'BAD_CHANNEL' });

  expect(db.insertSql).toBeUndefined();
});

it('sends with the thread row id as the gateway idempotency key', async () => {
  transport.resolveInstance.mockResolvedValue({ ok: true });
  transport.send.mockResolvedValue({ status: 'sent', provider_id: 'WAMSG1' });

  const { message, delivery } = await studioSend(ORG, client, 'u1', 'Hi', { channel: 'whatsapp' });

  expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
    orgId: ORG, to: '9876543210', text: 'Hi', clientMessageId: message.id,
  }));
  expect(message.delivery_status).toBe('sent');
  expect(delivery).toEqual({ ok: true, status: 'sent' });
  expect(notificationQuery()).toBeUndefined();
});

it('keeps a failed row, records the reason and reports 502 with the row', async () => {
  transport.resolveInstance.mockResolvedValue({ ok: true });
  transport.send.mockResolvedValue({ status: 'failed', error: 'recipient_not_on_whatsapp' });

  const { message, delivery } = await studioSend(ORG, client, 'u1', 'Hi', { channel: 'whatsapp' });

  expect(delivery).toMatchObject({ ok: false, reason: 'recipient_not_on_whatsapp' });
  expect(message.delivery_status).toBe('failed');
  expect(message.failure_reason).toBe('recipient_not_on_whatsapp');
  expect(notificationQuery()).toBeUndefined();
});

it('marks a thrown transport error failed instead of leaving it queued', async () => {
  transport.resolveInstance.mockResolvedValue({ ok: true });
  transport.send.mockRejectedValue(new Error('socket closed'));

  const { message, delivery } = await studioSend(ORG, client, 'u1', 'Hi', { channel: 'whatsapp' });

  expect(delivery).toMatchObject({ ok: false, reason: 'transport_error' });
  expect(message.delivery_status).toBe('failed');
  expect(message.failure_reason).toBe('transport_error');
});

it('defaults to the latest channel only when WhatsApp is usable', async () => {
  db.lastChannel = 'whatsapp';
  transport.resolveInstance.mockResolvedValue({ ok: true });
  transport.send.mockResolvedValue({ status: 'sent', provider_id: 'WAMSG1' });

  expect((await studioSend(ORG, client, 'u1', 'Hi')).delivery).toEqual({ ok: true, status: 'sent' });
  expect(db.insertParams.slice(5, 7)).toEqual(['whatsapp', 'text']);

  transport.resolveInstance.mockResolvedValue({ ok: false, reason: 'not_connected' });
  expect((await studioSend(ORG, client, 'u1', 'Hi')).delivery).toEqual({ ok: true, status: 'in_app' });
  expect(db.insertParams.slice(5, 7)).toEqual(['in_app', 'text']);
});

it('retries only a failed WhatsApp row and reuses its id', async () => {
  db.row = {
    id: 'm1', client_id: 'c1', body: 'Hi', channel: 'whatsapp', delivery_status: 'failed',
  };
  transport.resolveInstance.mockResolvedValue({ ok: true });
  transport.send.mockResolvedValue({ status: 'sent', provider_id: 'WAMSG1' });

  const out = await retryWhatsApp(ORG, client, 'm1');

  expect(out.message.delivery_status).toBe('sent');
  expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
    clientMessageId: 'm1', text: 'Hi',
  }));
});

it('refuses to retry a row that is not failed', async () => {
  db.row = {
    id: 'm1', client_id: 'c1', body: 'Hi', channel: 'whatsapp', delivery_status: 'sent',
  };

  expect(await retryWhatsApp(ORG, client, 'm1')).toBeNull();
  expect(transport.send).not.toHaveBeenCalled();
});

it('returns the row the sent event already advanced when the update misses', async () => {
  // The webhook's `sent` event can win the race against this HTTP response.
  // `markSent` then matches nothing because the row is no longer queued; the
  // response must still carry the row's CURRENT state, or the bubble shows
  // "Sending…" for a message that already went out.
  transport.resolveInstance.mockResolvedValue({ ok: true });
  transport.send.mockResolvedValue({ status: 'sent', provider_id: 'WAMSG1' });
  db.sentMiss = true;
  db.row = {
    id: 'm1', client_id: 'c1', body: 'Hi', channel: 'whatsapp',
    delivery_status: 'delivered', external_id: 'WAMSG1',
  };

  const { message, delivery } = await studioSend(ORG, client, 'u1', 'Hi', { channel: 'whatsapp' });

  expect(delivery).toEqual({ ok: true, status: 'sent' });
  expect(message.delivery_status).toBe('delivered');
});
