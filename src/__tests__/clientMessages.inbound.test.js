// Inbound WhatsApp -> the member's existing thread.
//
// The decisions worth pinning are the ones that would otherwise put a message
// in the wrong place or lose one entirely: phone matching across the formats
// WhatsApp uses, refusing to guess between two clients, retaining an
// unmatched message instead of dropping it, and truncating rather than failing
// on a body longer than the column allows.
//
// The pg client is faked at the query boundary: the module under test is the
// SQL and the branching around it, and a live database is not available in
// this suite.

const { applyInboundMessage } = require('../modules/client-messages/client-messages.inbound');

const ORG = '11111111-1111-4111-8111-111111111111';

const textPayload = (over = {}) => ({
  provider_message_id: 'WAMSG1',
  from_phone: '919876543210',
  push_name: 'Ravi',
  message_type: 'text',
  text: 'Hello coach',
  received_at: '2026-11-26T10:00:00.000Z',
  ...over,
});

function makeDb() {
  const db = {
    resolve: [{ id: 'c1', name: 'Ravi' }],
    insert: [{ id: 'm1' }],
    trainers: [{ id: 'u1' }],
    resolveSql: undefined,
    resolveParams: undefined,
    insertSql: undefined,
    insertParams: undefined,
    unmatchedSql: undefined,
    unmatchedParams: undefined,
    threadInsert: undefined,
  };

  db.client = {
    query: async (sql, params = []) => {
      if (/SELECT DISTINCT c\.id/i.test(sql)) {
        db.resolveSql = sql;
        db.resolveParams = params;
        return { rows: db.resolve, rowCount: db.resolve.length };
      }
      if (/INSERT INTO whatsapp_unmatched_messages/i.test(sql)) {
        db.unmatchedSql = sql;
        db.unmatchedParams = params;
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO client_messages/i.test(sql)) {
        db.insertSql = sql;
        db.insertParams = params;
        db.threadInsert = { sql, params };
        return { rows: db.insert, rowCount: db.insert.length };
      }
      if (/u\.role = 'trainer'/i.test(sql)) {
        return { rows: db.trainers, rowCount: db.trainers.length };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  return db;
}

let db;
beforeEach(() => {
  db = makeDb();
});

it('links a known phone and inserts one whatsapp message', async () => {
  const out = await applyInboundMessage({
    tenantId: ORG,
    payload: textPayload(),
    occurredAt: '2026-11-26T10:00:01.000Z',
    client: db.client,
  });

  expect(out.applied).toBe(1);
  expect(db.insertParams).toEqual([
    ORG, 'c1', 'Hello coach', 'text', 'WAMSG1', '2026-11-26T10:00:00.000Z',
  ]);
  expect(out.notifications).toEqual([{
    userId: 'u1',
    title: 'New WhatsApp message from Ravi',
    body: 'Hello coach',
    link: '/pt-os/messages?client=c1',
  }]);
});

it('stores a media placeholder rather than an empty body', async () => {
  await applyInboundMessage({
    tenantId: ORG,
    payload: textPayload({ message_type: 'image', text: null }),
    client: db.client,
  });

  expect(db.insertParams[2]).toBe('[Photo]');
});

it('truncates 2001 characters to 2000 ending in an ellipsis', async () => {
  await applyInboundMessage({
    tenantId: ORG,
    payload: textPayload({ text: 'x'.repeat(2001) }),
    client: db.client,
  });

  expect(db.insertParams[2]).toHaveLength(2000);
  expect(db.insertParams[2].endsWith('…')).toBe(true);
});

it('keeps a 2000-character body unchanged', async () => {
  await applyInboundMessage({
    tenantId: ORG,
    payload: textPayload({ text: 'x'.repeat(2000) }),
    client: db.client,
  });

  expect(db.insertParams[2]).toBe('x'.repeat(2000));
});

it('retains an unknown number and writes no thread row', async () => {
  db.resolve = [];
  const out = await applyInboundMessage({
    tenantId: ORG,
    payload: textPayload({ from_phone: '919000000000' }),
    client: db.client,
  });

  expect(out.applied).toBe(0);
  expect(db.threadInsert).toBeUndefined();
  expect(db.unmatchedParams).toContain('unknown_phone');
});

it('treats a number too short to be a phone as unknown without a lookup', async () => {
  const out = await applyInboundMessage({
    tenantId: ORG,
    payload: textPayload({ from_phone: '12345' }),
    client: db.client,
  });

  expect(out.applied).toBe(0);
  expect(db.resolveSql).toBeUndefined();
  expect(db.unmatchedParams).toContain('unknown_phone');
});

it('matches on the last ten digits of whatsapp or mobile and binds digits only', async () => {
  db.resolve = [{ id: 'c1', name: 'Ravi' }];
  await applyInboundMessage({
    tenantId: ORG,
    payload: textPayload({ from_phone: '+91 98765 43210' }),
    client: db.client,
  });

  expect(db.resolveSql).toMatch(/c\.whatsapp/i);
  expect(db.resolveSql).toMatch(/c\.mobile/i);
  expect(db.resolveSql).toMatch(/right\(regexp_replace\(COALESCE\(NULLIF\(btrim\(c\.whatsapp\), ''\), ''\), '\\D', '', 'g'\), 10\)/i);
  expect(db.resolveParams).toEqual([ORG, '919876543210']);
});

it('never guesses between two clients with the same number', async () => {
  db.resolve = [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }];
  const out = await applyInboundMessage({
    tenantId: ORG,
    payload: textPayload(),
    client: db.client,
  });

  expect(out.applied).toBe(0);
  expect(db.threadInsert).toBeUndefined();
  expect(db.unmatchedParams).toContain('ambiguous_phone');
});

it('treats a duplicate provider id under a new event id as a no-op', async () => {
  db.insert = [];
  const out = await applyInboundMessage({
    tenantId: ORG,
    payload: textPayload(),
    client: db.client,
  });

  expect(out.applied).toBe(0);
  expect(db.insertSql).toMatch(/ON CONFLICT \(organization_id, external_id\)[\s\S]*DO NOTHING/i);
});

it('clamps a future received_at with LEAST(..., NOW())', async () => {
  await applyInboundMessage({
    tenantId: ORG,
    payload: textPayload({ received_at: '2099-01-01T00:00:00.000Z' }),
    client: db.client,
  });

  expect(db.insertSql).toMatch(/LEAST\(COALESCE\(\$\d+::timestamptz, NOW\(\)\), NOW\(\)\)/i);
});
