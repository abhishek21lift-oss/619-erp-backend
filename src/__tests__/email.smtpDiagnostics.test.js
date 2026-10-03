// SMTP failure diagnostics — the fields that decide WHERE a send died.
//
// Why this file exists: production recorded `last_error = "Connection timeout"`
// and nothing else. That string is nodemailer's stage-'CONN' marker (see
// nodemailer/dist/cjs/smtp-connection/index.js:350 — `_onConnectionError(
// 'Connection timeout', 'ETIMEDOUT')`), so it does mean something precise — the
// TCP connection was never established — but only to somebody who knows that
// mapping. Everyone reading the Command Centre saw four words and no way to
// tell a firewall drop from a bad password from a rejected recipient.
//
// `code`, `stage` and `responseCode` were on the error object the whole time and
// were discarded at every boundary. These tests pin them to the boundaries.
'use strict';
jest.mock('nodemailer');
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ORIGINAL = { ...process.env };

const CFG = {
  SMTP_HOST: 'smtp.hostinger.com',
  SMTP_PORT: '465',
  SMTP_USER: 'support@myptstudio.com',
  SMTP_PASS: 'x',
};

/**
 * A transport whose sendMail rejects with `err`, shaped like nodemailer's.
 *
 * Returns the logger instance from the SAME module registry as the email module
 * under test. `jest.resetModules()` re-runs the logger mock factory, so a
 * logger captured at file scope is a different object by the time email.js has
 * required its own — its calls would land on an orphan and every assertion
 * here would pass vacuously.
 */
function load(err) {
  process.env = { ...ORIGINAL, ...CFG };
  jest.resetModules();
  const nm = require('nodemailer');
  nm.createTransport = jest.fn(() => ({ sendMail: jest.fn(async () => { throw err; }) }));
  const email = require('../lib/email');
  return { email, logger: require('../lib/logger') };
}

afterEach(() => {
  process.env = { ...ORIGINAL };
  jest.resetModules();
  jest.clearAllMocks();
});

/** The exact error nodemailer raises when net.connect() never completes. */
function connTimeout() {
  return Object.assign(new Error('Connection timeout'), {
    code: 'ETIMEDOUT', stage: 'CONN', command: 'CONN',
  });
}

describe('describeError — the SMTP failure, as data', () => {
  test('keeps message, code and stage so CONN is distinguishable from TLS or DATA', () => {
    const { email } = load(connTimeout());
    expect(email.describeError(connTimeout())).toMatchObject({
      message: 'Connection timeout',
      code: 'ETIMEDOUT',
      stage: 'CONN',
    });
  });

  test('carries responseCode and response when the server actually answered', () => {
    const { email } = load(connTimeout());
    const rejected = Object.assign(new Error('Invalid login: 535 5.7.8'), {
      code: 'EAUTH', command: 'AUTH', responseCode: 535, response: '535 5.7.8 Error: authentication failed',
    });
    expect(email.describeError(rejected)).toMatchObject({
      code: 'EAUTH', command: 'AUTH', responseCode: 535,
    });
  });

  test('never carries the password, in any field', () => {
    const { email } = load(connTimeout());
    const leaky = Object.assign(new Error('auth failed for support@myptstudio.com'), {
      code: 'EAUTH',
      // The shapes a driver can hand back that would otherwise be logged verbatim.
      auth: { user: 'support@myptstudio.com', pass: 'hunter2-super-secret' },
      command: 'AUTH PLAIN LOGIN',
      response: '535 5.7.8 auth failed',
    });
    const described = email.describeError(leaky);
    const serialised = JSON.stringify(described);
    expect(serialised).not.toContain('hunter2-super-secret');
    expect(Object.keys(described)).not.toContain('auth');
  });

  test('tolerates a non-Error throw — a rejected value must not throw here', () => {
    const { email } = load(connTimeout());
    expect(() => email.describeError('just a string')).not.toThrow();
    expect(email.describeError(undefined)).toMatchObject({ message: 'unknown error' });
  });
});

describe('sendWithRetry — the log line an operator reads at 3am', () => {
  test('logs code and stage, not just the message', async () => {
    const { email, logger } = load(connTimeout());
    await expect(email.sendWithRetry(
      { from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' },
      { kind: 'admin_invitation' },
    )).rejects.toThrow('Connection timeout');

    const lines = logger.warn.mock.calls.concat(logger.error.mock.calls);
    expect(lines.length).toBeGreaterThan(0);
    // Every logged failure carries the discriminator, not just the prose.
    for (const [fields] of lines) {
      expect(fields.code).toBe('ETIMEDOUT');
      expect(fields.stage).toBe('CONN');
    }
  });

  test('still throws the ORIGINAL error, so callers keep the full object', async () => {
    const original = connTimeout();
    const { email } = load(original);
    await expect(email.sendWithRetry({ from: 'a@b.c', to: 'd@e.f' })).rejects.toBe(original);
  });
});

describe('diagnose() — CONN is not the same failure as a blocked port mid-session', () => {
  test('a CONN-stage timeout is named as a connection that never opened', () => {
    const { email } = load(connTimeout());
    const d = email.diagnose(connTimeout());
    expect(d).toMatch(/never (opened|established)|could not (open|establish)/i);
    expect(d).not.toMatch(/465 is implicit TLS and 587 is/);
  });

  test('an ETIMEDOUT with no CONN stage keeps the generic port-pairing advice', () => {
    const { email } = load(connTimeout());
    const d = email.diagnose(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    expect(d).toMatch(/implicit TLS|block outbound/i);
  });

  test('a post-connection socket timeout is called out as submission-stage', () => {
    const { email } = load(connTimeout());
    const d = email.diagnose(Object.assign(new Error('Message timeout'), {
      code: 'ETIMEDOUT', stage: 'DATA',
    }));
    // DATA-stage means the server may already have accepted the message, which
    // is the duplicate-send hazard and must not be described as a connect fault.
    expect(d).toMatch(/may already have (been )?(accepted|queued)|duplicate/i);
  });
});
