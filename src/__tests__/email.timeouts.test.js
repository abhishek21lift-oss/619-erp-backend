// SMTP timeouts are bounded, and a blackholed port fails fast and legibly.
//
// ── Why ──────────────────────────────────────────────────────────────────────
//
// Production recorded `Connection timeout` — nodemailer's stage-CONN marker,
// raised at smtp-connection/index.js:350 as `_onConnectionError('Connection
// timeout', 'ETIMEDOUT')` when net.connect() never completes.
//
// The distinction that sets the cost: a REFUSED connection is ECONNREFUSED and
// returns instantly. ETIMEDOUT means the SYN went unanswered — the path is
// blackholed (a firewall dropping outbound SMTP, or the provider refusing this
// source). Nothing is listening to reject it, so the only thing that ends the
// wait is a timeout.
//
// lib/email.js set none, so nodemailer's defaults applied
// (smtp-connection/index.js:49-51):
//
//     CONNECTION_TIMEOUT  2 minutes      <-- the one that fires here
//     GREETING_TIMEOUT    30 seconds
//     SOCKET_TIMEOUT      10 minutes
//
// With SMTP_SEND_ATTEMPTS=3 and the 500ms/1s backoff, one invitation send against
// a blackholed port blocks the request for roughly 3 x 120s = 6 minutes. The
// invitation routes run this inline (deliverInvitation calls sendWithRetry
// directly, not through the BullMQ dispatcher), so that is six minutes a request
// thread is pinned — on studio creation and on Resend.
//
// Measured from the public internet, the same host answers in 90ms (TCP) and
// 801ms (TLS). The bound below is generous by two orders of magnitude against a
// healthy path while cutting the pathological one from minutes to seconds.
//
// ── What this does NOT do ────────────────────────────────────────────────────
//
// It does not make mail deliver. If egress to 465 is blocked, mail still does
// not send — this makes the failure fast, bounded and identifiable instead of a
// six-minute hang, so the operational signal arrives while it is still true.
// The delivery fix is network egress, not code.
'use strict';
jest.mock('nodemailer');
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ORIGINAL = { ...process.env };
let lastTransportOptions = null;

/** Load lib/email with the transport options captured. */
function load(env = {}) {
  process.env = { ...ORIGINAL, ...env };
  jest.resetModules();
  const nm = require('nodemailer');
  nm.createTransport = jest.fn((opts) => {
    lastTransportOptions = opts;
    return { sendMail: jest.fn(async () => ({ messageId: 'x' })), verify: jest.fn(async () => true) };
  });
  return require('../lib/email');
}

/** Force the transport to be built so its options are observable. */
async function buildTransportOptions(env) {
  const email = load(env);
  await email.sendRaw({ to: 'a@b.c', subject: 's', text: 't' });
  return lastTransportOptions;
}

afterEach(() => {
  process.env = { ...ORIGINAL };
  jest.resetModules();
  lastTransportOptions = null;
});

const CFG = { SMTP_HOST: 'smtp.hostinger.com', SMTP_PORT: '465', SMTP_USER: 'u@x.com', SMTP_PASS: 'x' };

describe('SMTP timeouts are bounded', () => {
  it('sets all three timeouts, none of them the nodemailer default', async () => {
    const opts = await buildTransportOptions(CFG);

    // Defaults would be 120000 / 30000 / 600000.
    expect(opts.connectionTimeout).toBeLessThan(120_000);
    expect(opts.greetingTimeout).toBeLessThan(30_000);
    expect(opts.socketTimeout).toBeLessThan(600_000);
  });

  it('uses the documented defaults when nothing is configured', async () => {
    const email = load(CFG);
    const t = email.smtpTimeouts();
    expect(t).toEqual({
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
    expect(email.SMTP_TIMEOUT_DEFAULTS).toEqual(t);
  });

  it('passes them to the transport unchanged', async () => {
    const opts = await buildTransportOptions(CFG);
    const t = load(CFG).smtpTimeouts();
    expect(opts.connectionTimeout).toBe(t.connectionTimeout);
    expect(opts.greetingTimeout).toBe(t.greetingTimeout);
    expect(opts.socketTimeout).toBe(t.socketTimeout);
  });

  it('keeps the implicit-TLS decision on the port alone', async () => {
    // Untouched by this change, and load-bearing: 465 is implicit TLS, 587 is
    // STARTTLS. A wrong pairing fails at the TLS stage, not CONN.
    expect((await buildTransportOptions({ ...CFG, SMTP_PORT: '465' })).secure).toBe(true);
    expect((await buildTransportOptions({ ...CFG, SMTP_PORT: '587' })).secure).toBe(false);
  });

  it('still sends the SNI servername so cert validation has a name to check', async () => {
    // The host may be an IP literal (IPv4 pinning), and omitting servername
    // leaves `false` — validation against an IP, which fails against any normal
    // certificate. Independent of timeouts; pinned here so it cannot regress.
    expect((await buildTransportOptions(CFG)).servername).toBe('smtp.hostinger.com');
  });
});

describe('timeout overrides are clamped, not trusted', () => {
  it('honours a valid override', () => {
    expect(load({ ...CFG, SMTP_CONNECTION_TIMEOUT_MS: '30000' }).smtpTimeouts().connectionTimeout).toBe(30_000);
  });

  it('ignores a value that would disable the bound', () => {
    // 0 or a negative number is the classic way to accidentally remove a
    // timeout; nodemailer reads those as falsy and falls back to its own.
    const t = load({ ...CFG, SMTP_CONNECTION_TIMEOUT_MS: '0' }).smtpTimeouts();
    expect(t.connectionTimeout).toBe(20_000);
  });

  it('ignores a value long enough to reintroduce the hang', () => {
    const t = load({ ...CFG, SMTP_CONNECTION_TIMEOUT_MS: '600000' }).smtpTimeouts();
    expect(t.connectionTimeout).toBeLessThanOrEqual(120_000);
  });

  it('ignores nonsense without throwing', () => {
    for (const v of ['abc', '', '-5', 'NaN', '1e999']) {
      expect(() => load({ ...CFG, SMTP_CONNECTION_TIMEOUT_MS: v }).smtpTimeouts()).not.toThrow();
    }
    expect(load({ ...CFG, SMTP_CONNECTION_TIMEOUT_MS: 'abc' }).smtpTimeouts().connectionTimeout).toBe(20_000);
  });

  it('warns once per bad value so a typo is visible in the log', () => {
    const email = load({ ...CFG, SMTP_CONNECTION_TIMEOUT_MS: 'soon' });
    email.smtpTimeouts();
    // Required AFTER load(): that resets the module registry, so a logger
    // grabbed beforehand is a different instance from the one lib/email.js
    // holds, and the assertion would pass or fail for the wrong reason.
    const logger = require('../lib/logger');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'soon' }), 'ai_smtp_timeout_invalid'
    );
  });
});
