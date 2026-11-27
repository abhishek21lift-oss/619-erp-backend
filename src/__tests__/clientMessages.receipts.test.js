// WhatsApp delivery receipts -> the thread row that produced them.
//
// The thread is tried before communication_logs so the in-app bubble can show
// Sent/Delivered/Read. The statements are ordering-aware on purpose: receipts
// and retries are not ordered, and a late `delivered` must never pull a `read`
// row backwards.
//
// No live database here: these tests read the SQL the module issues.

const {
  applyThreadSent,
  applyThreadReceipt,
  applyThreadFailure,
  sanitiseFailureReason,
} = require('../modules/client-messages/client-messages.inbound');

const ORG = '11111111-1111-4111-8111-111111111111';

function makeDb() {
  const db = { rowCount: 1 };
  db.client = {
    query: async (sql, params = []) => {
      if (!/UPDATE client_messages/i.test(sql)) throw new Error(`unexpected query: ${sql}`);
      if (/SET external_id = \$3/i.test(sql)) {
        db.sentSql = sql;
        db.sentParams = params;
      } else if (/SET delivery_status = 'failed'/i.test(sql)) {
        db.failureSql = sql;
        db.failureParams = params;
      } else {
        db.receiptSql = sql;
        db.receiptParams = params;
      }
      return { rows: [], rowCount: db.rowCount };
    },
  };
  return db;
}

let db;
beforeEach(() => {
  db = makeDb();
});

it('sets delivered and does not overwrite a later read', async () => {
  await applyThreadReceipt({
    tenantId: ORG,
    kind: 'delivered',
    payload: { provider_message_id: 'W1', delivered_at: '2026-11-26T10:00:00.000Z' },
    client: db.client,
  });
  await applyThreadReceipt({
    tenantId: ORG,
    kind: 'read',
    payload: { provider_message_id: 'W1', read_at: '2026-11-26T10:05:00.000Z' },
    client: db.client,
  });

  expect(db.receiptSql).toMatch(/WHEN \$3 = 'read' THEN 'read'/i);
  expect(db.receiptSql).toMatch(/WHEN \$3 = 'delivered' AND delivery_status <> 'read' THEN 'delivered'/i);
});

it('records a read receipt on provider_read_at, never read_at', async () => {
  await applyThreadReceipt({
    tenantId: ORG,
    kind: 'read',
    payload: { provider_message_id: 'W1', read_at: '2026-11-26T10:05:00.000Z' },
    client: db.client,
  });

  expect(db.receiptSql).toMatch(/provider_read_at = CASE\s+WHEN \$3 = 'read'/i);
  expect(db.receiptSql).not.toMatch(/\bread_at\s*=/i);
});

it('binds the timestamp from the field that matches the receipt kind', async () => {
  await applyThreadReceipt({
    tenantId: ORG,
    kind: 'delivered',
    payload: { provider_message_id: 'W1', delivered_at: '2026-11-26T10:00:00.000Z' },
    client: db.client,
  });
  expect(db.receiptParams).toEqual([ORG, 'W1', 'delivered', '2026-11-26T10:00:00.000Z']);

  await applyThreadReceipt({
    tenantId: ORG,
    kind: 'read',
    payload: { provider_message_id: 'W1', read_at: '2026-11-26T10:05:00.000Z' },
    client: db.client,
  });
  expect(db.receiptParams).toEqual([ORG, 'W1', 'read', '2026-11-26T10:05:00.000Z']);
});

it('heals a lost send response by client_message_id only while queued', async () => {
  await applyThreadSent({
    tenantId: ORG,
    payload: { client_message_id: 'm1', provider_message_id: 'W1' },
    client: db.client,
  });

  expect(db.sentSql).toMatch(/delivery_status = 'queued'/i);
  expect(db.sentParams).toEqual(['m1', ORG, 'W1']);
});

it('marks a failed thread row and ignores will_retry', async () => {
  await applyThreadFailure({
    tenantId: ORG,
    payload: {
      client_message_id: 'm1',
      reason_code: 'recipient_not_on_whatsapp',
      will_retry: true,
    },
    client: db.client,
  });

  expect(db.failureSql).toMatch(/delivery_status NOT IN \('sent','delivered','read'\)/i);
  expect(db.failureParams).toContain('recipient_not_on_whatsapp');
});

it('lowercases and bounds the failure reason', () => {
  expect(sanitiseFailureReason('RECIPIENT_NOT_ON_WHATSAPP')).toBe('recipient_not_on_whatsapp');
  expect(sanitiseFailureReason(undefined)).toBe('gateway_failed');
  expect(sanitiseFailureReason('x'.repeat(100))).toHaveLength(64);
});
