// Addressing a WhatsApp message to a real phone.
//
// ── The production failure this suite pins down ─────────────────────────────
//
// Every client mobile in this database is ten bare digits — how an Indian
// studio writes a number down. The send path passed that string through
// untouched and the gateway turned it into "8756562310@s.whatsapp.net", a JID
// belonging to nobody. Baileys resolves a send to a JID that does not exist
// exactly like a real one: it returns a message key, so the worker recorded
// 'sent', wrote the provider id, and the studio's log showed a row that looked
// delivered.
//
// The evidence that it was not: across eight such sends over eight days,
// exactly zero whatsapp.message.delivered receipts came back — while receipts
// for messages the owner typed by hand on the same account arrived normally.
//
// So the two things this suite refuses to let regress are (1) a national
// number reaches the gateway with its country code, and (2) a number that
// CANNOT be resolved fails loudly and without touching a provider, rather than
// being sent into the void with a success recorded against it.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const ORG = '11111111-1111-4111-8111-111111111111';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ query: (...a) => mockQuery(...a) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockGatewaySend = jest.fn();
jest.mock('../lib/whatsappGateway', () => ({
  isConfigured: () => true,
  sendMessage: (...a) => mockGatewaySend(...a),
}));

const { toE164 } = require('../modules/messaging/phone');
const transport = require('../modules/messaging/transport');

/** A connected instance, so resolveInstance() lets the send through. */
function connected() {
  mockQuery.mockImplementation(async (sql) => {
    if (/FROM whatsapp_instances/.test(sql)) {
      return { rows: [{ instance_id: 'inst-1', status: 'connected', phone_e164: '+918858982354' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

const send = (to) =>
  transport.send({ orgId: ORG, to, text: 'hi', clientMessageId: 'log-1' });

/** What the gateway was actually asked to send to. */
const sentTo = () => mockGatewaySend.mock.calls[0]?.[2]?.to;

beforeEach(() => {
  mockQuery.mockReset();
  mockGatewaySend.mockReset();
  mockGatewaySend.mockResolvedValue({
    ok: true, status: 200, data: { provider_message_id: 'WAMSG1', duplicate: false }, code: null,
  });
});

describe('toE164', () => {
  test('a bare national number gains the country code', () => {
    expect(toE164('8756562310')).toEqual({ ok: true, e164: '+918756562310', normalized: true });
  });

  test('the domestic trunk 0 is dropped rather than carried into the JID', () => {
    expect(toE164('08756562310').e164).toBe('+918756562310');
  });

  test('punctuation and spaces are not part of a number', () => {
    expect(toE164('+91 87565-62310').e164).toBe('+918756562310');
    expect(toE164('98765 43210').e164).toBe('+919876543210');
  });

  test('an international number is taken as written, not re-prefixed', () => {
    expect(toE164('+14155552671')).toEqual({ ok: true, e164: '+14155552671', normalized: false });
    expect(toE164('918756562310')).toEqual({ ok: true, e164: '+918756562310', normalized: false });
    expect(toE164('00918756562310').e164).toBe('+918756562310');
  });

  // The reason the rule is length and not "does it start with 91": Indian
  // mobiles start with 6-9, so a perfectly ordinary national number can begin
  // with the country code's own digits. A prefix test reads this one as an
  // international number two digits short and sends it to a stranger.
  test('a national number that happens to begin 91 is still national', () => {
    expect(toE164('9198765432')).toEqual({ ok: true, e164: '+919198765432', normalized: true });
  });

  test('a number of no recognised shape is refused, not guessed at', () => {
    expect(toE164('12345').ok).toBe(false);
    expect(toE164('87565623101').ok).toBe(false); // 11 digits, no known shape
    expect(toE164('').ok).toBe(false);
    expect(toE164(null).ok).toBe(false);
    expect(toE164('+919876543210123456').reason).toBe('out_of_range');
  });

  test("a '+' that is not at the front is a typo, not a country code", () => {
    expect(toE164('9876543210+919876543210').ok).toBe(false);
  });

  test('the country code and national length are configuration', () => {
    expect(toE164('5551234', { defaultCountryCode: '44', nationalNumberLength: 7 }).e164)
      .toBe('+445551234');
  });
});

describe('transport.send addresses the message before any provider sees it', () => {
  test('a stored national number reaches the gateway in E.164', async () => {
    connected();
    const out = await send('8756562310');

    expect(out.status).toBe(transport.SendStatus.SENT);
    expect(sentTo()).toBe('+918756562310');
  });

  test('an already-international number is passed through unchanged', async () => {
    connected();
    await send('+919876543210');
    expect(sentTo()).toBe('+919876543210');
  });

  // The whole point. Before this, the gateway was handed the number, made a
  // JID out of it, and returned a provider id for a message nobody received.
  test('an unaddressable number fails without the gateway being called', async () => {
    connected();
    const out = await send('12345');

    expect(out.status).toBe(transport.SendStatus.FAILED);
    expect(out.error).toMatch(/^invalid_recipient_/);
    // Non-retryable: no number of attempts makes an unparseable number valid,
    // and the worker's budget must not be spent discovering that.
    expect(out.retryable).toBe(false);
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  // The other half of the same defence, at the gateway. The backend resolving
  // the number removes today's cause; the gateway asking WhatsApp whether
  // anybody actually has it catches the class — a client's number typed wrong
  // produces the identical silent non-delivery with no code change behind it.
  test("the gateway's not-on-WhatsApp refusal is permanent, not a blip", async () => {
    connected();
    mockGatewaySend.mockResolvedValue({
      ok: false, status: 422, code: 'RECIPIENT_NOT_ON_WHATSAPP', data: null,
    });

    const out = await send('+919876543210');

    expect(out.status).toBe(transport.SendStatus.FAILED);
    expect(out.error).toBe('recipient_not_on_whatsapp');
    // Not retryable: the number will not be registered on the second attempt
    // either, and the worker's budget is for failures a retry can fix.
    expect(out.retryable).toBe(false);
  });

  test('the shared-provider fallback gets the same resolved number', async () => {
    connected();
    mockGatewaySend.mockResolvedValue({ ok: false, status: 500, code: 'INTERNAL', data: null });
    const twilio = require('../services/whatsappDelivery');
    const spy = jest.spyOn(twilio, 'sendText').mockResolvedValue({ status: 'sent', provider_id: 'TW1' });

    await transport.send({
      orgId: ORG, to: '8756562310', text: 'hi', clientMessageId: 'log-1',
      allowSharedProvider: true,
    });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ to: '+918756562310' }));
    spy.mockRestore();
  });
});
