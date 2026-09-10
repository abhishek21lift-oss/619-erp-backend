// Delivering a queued automated message: the worker, the transport, and the
// receipts that come back.
//
// ── The window this suite is about ─────────────────────────────────────────
//
// A rule may carry a delay of hours — "3 days before expiry" is a delay — so
// there is a long gap between the engine deciding to send and the worker
// sending. Every fact the engine checked can change inside that gap: a studio
// owner switches automation off, revokes a trainer, or their WhatsApp drops.
//
// A kill switch that only stops messages nobody had queued yet is not a kill
// switch, so the worker re-checks all of it. These tests are what make that
// re-checking non-optional.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ query: (...a) => mockQuery(...a) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockGatewaySend = jest.fn();
jest.mock('../lib/whatsappGateway', () => ({
  isConfigured: () => true,
  sendMessage: (...a) => mockGatewaySend(...a),
}));

const { processAutomationJob } = require('../services/whatsapp.service');
const transport = require('../modules/messaging/transport');

const ROW = {
  id: 'log-1',
  organization_id: ORG_A,
  recipient_id: 'client-1',
  recipient_phone: '+919876543210',
  message: 'Hi Asha, we got ₹2,500.',
  status: 'queued',
  automation_rule_id: 'rule-1',
  external_id: null,
};

const CLIENT = { id: 'client-1', name: 'Asha', phone: '+919876543210', trainer_id: 'trainer-a' };

function db({
  row = ROW,
  settings = { automation_enabled: true, daily_send_limit: 200 },
  client = CLIENT,
  grant = true,
  instance = { instance_id: 'inst-1', status: 'connected', phone_e164: '+911111111111' },
} = {}) {
  mockQuery.mockImplementation(async (sql) => {
    if (/FROM communication_logs/.test(sql)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    if (/FROM whatsapp_automation_settings/.test(sql)) return { rows: settings ? [settings] : [], rowCount: 1 };
    if (/FROM pt_clients/.test(sql)) return { rows: client ? [client] : [], rowCount: client ? 1 : 0 };
    if (/whatsapp_automation_trainer_grants/.test(sql)) return { rows: grant ? [{ n: 1 }] : [], rowCount: grant ? 1 : 0 };
    if (/FROM whatsapp_instances/.test(sql)) return { rows: instance ? [instance] : [], rowCount: instance ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  });
}

const job = (data = {}) => ({ id: 'job-1', data: { type: 'automation', logId: 'log-1', orgId: ORG_A, ...data } });

/** The UPDATE statements this run issued, as normalised text. */
const updates = () =>
  mockQuery.mock.calls
    .filter(([sql]) => /^\s*UPDATE communication_logs/.test(sql))
    .map(([sql, params]) => ({ sql: sql.replace(/\s+/g, ' ').trim(), params }));

/**
 * The markSent statement, found by what it writes rather than by the literal
 * `status = 'sent'`.
 *
 * That literal no longer appears: markSent moves the status through a CASE, so
 * that a receipt which has already advanced the row to delivered or read is
 * not pulled back to sent when the worker's send call finally returns. The
 * assertions below are unchanged — external_id is what uniquely identifies
 * this statement, and it is what they were really about.
 */
const sentUpdate = () => updates().find((u) => /external_id/.test(u.sql));

beforeEach(() => {
  mockQuery.mockReset();
  mockGatewaySend.mockReset();
  mockGatewaySend.mockResolvedValue({ ok: true, status: 200, data: { provider_message_id: 'WAMSG1', duplicate: false }, code: null });
});

describe('the happy path', () => {
  test('sends on the studio\'s own instance and records the provider id', async () => {
    db();
    const out = await processAutomationJob(job());

    expect(out.status).toBe('sent');
    expect(mockGatewaySend).toHaveBeenCalledWith(
      ORG_A, 'inst-1',
      expect.objectContaining({ to: ROW.recipient_phone, text: ROW.message }),
      undefined,
    );
    const sent = sentUpdate();
    expect(sent.params).toEqual(['log-1', ORG_A, 'WAMSG1', 'baileys']);
    // And it advances the status rather than asserting it — see FIX 1.
    expect(sent.sql).toMatch(/status = CASE WHEN status IN \('delivered','read'\)/);
  });

  test('uses the log row id as the client_message_id, stable across retries', async () => {
    // This is what lets the gateway recognise a retry of this job rather than
    // sending the client a second copy.
    db();
    await processAutomationJob(job());
    expect(mockGatewaySend.mock.calls[0][2].clientMessageId).toBe('log-1');
  });

  test('resolves the instance for the job\'s organization only', async () => {
    db();
    await processAutomationJob(job());
    const call = mockQuery.mock.calls.find(([sql]) => /FROM whatsapp_instances/.test(sql));
    expect(call[1]).toEqual([ORG_A]);
  });
});

describe('tenant isolation', () => {
  test('a job whose payload names the wrong organization sends nothing', async () => {
    // A job payload is not a credential — it can be edited in Redis or built
    // wrongly by a bug — so the organization is used as an assertion against
    // the row, never as a lookup key.
    db({ row: null });
    const out = await processAutomationJob(job({ orgId: ORG_B }));

    expect(out).toMatchObject({ status: 'skipped', reason: 'row_not_found' });
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  test('the row lookup binds both the id and the organization', async () => {
    db();
    await processAutomationJob(job());
    const call = mockQuery.mock.calls.find(([sql]) => /SELECT id, organization_id/.test(sql));
    expect(call[1]).toEqual(['log-1', ORG_A]);
  });

  test('a job with no organization refuses rather than defaulting', async () => {
    db();
    await expect(processAutomationJob(job({ orgId: undefined }))).rejects.toThrow(/missing logId or orgId/);
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });
});

describe('permission is re-checked at send time, not only at queue time', () => {
  test('a studio that switched automation off after queueing does not send', async () => {
    db({ settings: { automation_enabled: false, daily_send_limit: 200 } });
    const out = await processAutomationJob(job());

    expect(out).toMatchObject({ status: 'skipped', reason: 'automation_disabled' });
    expect(mockGatewaySend).not.toHaveBeenCalled();
    // Recorded, so the studio can see their change took effect on messages
    // that were already in flight.
    expect(updates().some((u) => u.params.includes('automation_disabled'))).toBe(true);
  });

  test('a trainer whose grant was revoked while the message waited does not send', async () => {
    db({ grant: false });
    const out = await processAutomationJob(job());

    expect(out).toMatchObject({ status: 'skipped', reason: 'trainer_not_permitted' });
    expect(mockGatewaySend).not.toHaveBeenCalled();
    expect(updates().some((u) => u.params.includes('trainer_not_permitted'))).toBe(true);
  });

  test('an already-sent row is not sent again', async () => {
    db({ row: { ...ROW, status: 'sent', external_id: 'WAMSG1' } });
    const out = await processAutomationJob(job());
    expect(out).toMatchObject({ status: 'skipped', reason: 'already_sent' });
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });
});

describe('a disconnected WhatsApp', () => {
  test('does not send, and does not retry', async () => {
    // No number of retries reconnects a socket only the studio can restore by
    // scanning a QR. Throwing here would burn the whole attempt budget and
    // still fail.
    db({ instance: { instance_id: 'inst-1', status: 'disconnected', phone_e164: null } });
    const out = await processAutomationJob(job());

    expect(out.status).toBe('failed');
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  test('records why, so an operator does not have to read the worker logs', async () => {
    db({ instance: { instance_id: 'inst-1', status: 'disconnected', phone_e164: null } });
    await processAutomationJob(job());
    const failed = updates().find((u) => /status = 'failed'/.test(u.sql));
    expect(failed.params).toContain('whatsapp_disconnected');
  });

  test('a studio that never connected WhatsApp is the same answer', async () => {
    db({ instance: null });
    const out = await processAutomationJob(job());
    expect(out.status).toBe('failed');
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  test('never falls back to a shared platform number', async () => {
    // The one place in this codebase that refuses to degrade. A message from
    // an unrecognised number is not a worse version of the studio's message —
    // it is somebody else messaging their client.
    db({ instance: null });
    await processAutomationJob(job());
    const twilio = jest.requireActual('../services/whatsappDelivery');
    expect(typeof twilio.sendText).toBe('function'); // it exists…
    expect(mockGatewaySend).not.toHaveBeenCalled(); // …and was not reached
  });
});

describe('failures and retries', () => {
  test('a transport failure throws, so BullMQ retries it', async () => {
    db();
    mockGatewaySend.mockResolvedValue({ ok: false, status: 500, data: null, code: 'INTERNAL' });
    await expect(processAutomationJob(job())).rejects.toThrow();
  });

  test('a duplicate already in flight at the gateway does NOT retry', async () => {
    // Retrying would race the send that is already running, and the outcome of
    // that race is which of two messages the client gets.
    db();
    mockGatewaySend.mockResolvedValue({ ok: false, status: 409, data: null, code: 'DUPLICATE_MESSAGE' });
    const out = await processAutomationJob(job());
    expect(out.status).toBe('failed');
    expect(out.reason).toBe('duplicate_in_flight');
  });

  test('a replay the gateway recognised is recorded as sent with the ORIGINAL id', async () => {
    // The message reached the client once, which is the outcome we wanted.
    db();
    mockGatewaySend.mockResolvedValue({
      ok: true, status: 200, code: null,
      data: { provider_message_id: 'WAMSG-ORIGINAL', duplicate: true },
    });
    const out = await processAutomationJob(job());

    expect(out).toMatchObject({ status: 'sent', provider_id: 'WAMSG-ORIGINAL', duplicate: true });
    expect(sentUpdate().params).toContain('WAMSG-ORIGINAL');
  });

  test('an unreachable gateway is retryable', async () => {
    db();
    mockGatewaySend.mockResolvedValue({ ok: false, status: 0, data: null, code: 'GATEWAY_UNREACHABLE' });
    await expect(processAutomationJob(job())).rejects.toThrow();
  });
});

describe('the transport itself', () => {
  test('refuses a send with no organization', async () => {
    const res = await transport.send({ to: '+919876543210', text: 'hi', clientMessageId: 'x' });
    expect(res.status).toBe('failed');
    expect(res.error).toBe('no_organization');
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  test('refuses a send with no client_message_id', async () => {
    // Without it the gateway cannot dedupe, so a retry would send twice.
    const res = await transport.send({ orgId: ORG_A, to: '+919876543210', text: 'hi' });
    expect(res.status).toBe('failed');
    expect(res.error).toBe('no_client_message_id');
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  test('only falls back to a shared provider when explicitly permitted', async () => {
    db({ instance: null });
    const refused = await transport.send({
      orgId: ORG_A, to: '+91', text: 'hi', clientMessageId: 'x', allowSharedProvider: false,
    });
    expect(refused.status).toBe('not_connected');
    expect(refused.provider).toBe('baileys');
  });

  test('a connected instance is required, not merely an existing one', async () => {
    for (const state of ['connecting', 'reconnecting', 'logged_out', 'qr_timeout', 'failed', 'never_connected']) {
      db({ instance: { instance_id: 'inst-1', status: state, phone_e164: null } });
      const res = await transport.send({ orgId: ORG_A, to: '+91', text: 'hi', clientMessageId: 'x' });
      expect({ state, status: res.status }).toEqual({ state, status: 'not_connected' });
    }
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });
});
