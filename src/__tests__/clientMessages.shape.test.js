// The thread's shape after WhatsApp joined it.
//
// The trainer's inbox needs to know which channel a conversation last used,
// and the composer needs to know whether WhatsApp can actually be used right
// now. Both are computed on the server: the frontend must not infer
// "connected" from a stale row or from the presence of a phone number.
//
// These tests read the SQL the service issues; no live database is involved.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../modules/messaging/transport', () => ({ resolveInstance: jest.fn() }));

const pool = require('../db/pool');
const transport = require('../modules/messaging/transport');
const {
  thread, inbox, studioClient, channelState,
} = require('../modules/client-messages/client-messages.service');

const ORG = '11111111-1111-4111-8111-111111111111';

let db;
beforeEach(() => {
  db = { lastSql: undefined, lastParams: undefined, rows: [] };
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql, params) => {
    db.lastSql = sql;
    db.lastParams = params;
    return { rows: db.rows, rowCount: db.rows.length };
  });
  transport.resolveInstance.mockReset();
});

it('reads the new message fields in every thread query', async () => {
  await thread(ORG, 'c1');
  expect(db.lastSql).toMatch(/channel, message_type, delivery_status, failure_reason/i);
});

it('names the latest channel in the inbox', async () => {
  await inbox(ORG);
  expect(db.lastSql).toMatch(/l\.channel AS last_channel/i);
});

it('selects both phone columns on the client', async () => {
  await studioClient(ORG, 'c1');
  expect(db.lastSql).toMatch(/c\.whatsapp/i);
  expect(db.lastSql).toMatch(/c\.mobile/i);
});

it('defaults to WhatsApp when the latest message was WhatsApp and the instance is connected', async () => {
  transport.resolveInstance.mockResolvedValue({ ok: true });
  const state = await channelState(ORG, 'c1', 'whatsapp');
  expect(state).toEqual({ default: 'whatsapp', whatsapp_available: true });
});

it('defaults to in_app when the latest was WhatsApp but the instance is not connected', async () => {
  transport.resolveInstance.mockResolvedValue({ ok: false, reason: 'not_connected' });
  const state = await channelState(ORG, 'c1', 'whatsapp');
  expect(state).toEqual({ default: 'in_app', whatsapp_available: false });
});

it('keeps in_app as the default when the latest message was in_app', async () => {
  transport.resolveInstance.mockResolvedValue({ ok: true });
  expect((await channelState(ORG, 'c1', 'in_app')).default).toBe('in_app');
});

it('reads the newest channel when the caller does not supply one', async () => {
  db.rows = [{ channel: 'whatsapp' }];
  transport.resolveInstance.mockResolvedValue({ ok: true });

  const state = await channelState(ORG, 'c1');

  expect(db.lastSql).toMatch(/SELECT channel FROM client_messages/i);
  expect(state).toEqual({ default: 'whatsapp', whatsapp_available: true });
});
