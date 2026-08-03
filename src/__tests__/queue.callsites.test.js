'use strict';

/**
 * The call sites that were rewired, and the promise that they behave the same.
 *
 * Four flows now go through enqueue(): the password reset, the admin reset
 * OTP, AI document ingestion and its reindex. Requirement five of this piece
 * of work was that every existing endpoint stays compatible, and "compatible"
 * has a precise meaning here: with no Redis — which is the state in
 * production today — each of these must do exactly what it did before, call
 * the same function, with the same arguments.
 *
 * So these tests run with REDIS_URL unset on purpose. That is not a
 * limitation of the test environment; it is the deployed configuration.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';
delete process.env.REDIS_URL;

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

describe('rewired call sites keep their inline fallback', () => {
  // Each of these passes the ORIGINAL call as enqueue()'s fourth argument.
  // Losing that argument is the way this refactor breaks silently: the job
  // would queue fine in an environment with Redis and throw in the one
  // without, which is production.
  const sites = [
    ['routes/auth.js', 'sendPasswordReset(email, rawToken)'],
    ['routes/admin-reset.js', 'sendAdminResetOtp(email, otp)'],
    ['routes/aiKnowledge.js', 'ingestDocument(id)'],
    ['routes/aiKnowledge.js', 'ingestDocument(req.params.id)'],
  ];

  it.each(sites)('%s still calls %s inline', (file, call) => {
    const src = read(file);
    expect(src).toContain(`() => ${call}`);
  });

  it.each([...new Set(sites.map((s) => s[0]))])('%s imports enqueue from the one module', (file) => {
    expect(read(file)).toMatch(/require\('\.\.\/lib\/queue'\)/);
  });
});

describe('AI ingestion', () => {
  it('de-duplicates an upload but not a reindex', () => {
    // A double-tap on Upload must not embed the same PDF twice — that is
    // minutes of CPU and a duplicated chunk set. A reindex is a deliberate
    // "do it again", so de-duplicating it against the original ingestion
    // would make the button silently do nothing.
    const src = read('routes/aiKnowledge.js');
    const upload = src.slice(src.indexOf("'ingest'"), src.indexOf("'reindex'"));
    expect(upload).toContain('jobId');
    const reindex = src.slice(src.indexOf("'reindex'"));
    expect(reindex.slice(0, 300)).not.toContain('jobId');
  });
});

describe('the OTP send no longer blocks the response', () => {
  it('hands the mail to the queue instead of awaiting SMTP directly', () => {
    // This was the one send still sitting in front of a response: the admin
    // waited on the whole SMTP round trip — three retries with backoff on a
    // bad day — before being told the code was on its way.
    const src = read('routes/admin-reset.js');
    expect(src).not.toMatch(/await\s+sendAdminResetOtp\(/);
    expect(src).toMatch(/await\s+enqueue\(/);
    // The OTP row must still be committed before the mail is handed over, or
    // a fast worker could deliver a code the database does not know about.
    expect(src.indexOf('INSERT INTO')).toBeLessThan(src.indexOf('enqueue('));
  });
});

describe('handlers', () => {
  const handlers = require('../workers/queue/handlers');

  it('exposes one handler per queue', () => {
    const { QUEUES } = require('../lib/queue');
    for (const name of Object.values(QUEUES)) {
      expect(typeof handlers[name]).toBe('function');
    }
  });

  it('treats unconfigured SMTP as a no-op, not a failure to retry', async () => {
    // Retrying an unconfigured mailer five times with exponential backoff
    // produces five identical log lines and no mail.
    jest.resetModules();
    jest.doMock('../lib/email', () => ({
      isConfigured: () => false,
      describeConfig: () => ({ state: 'absent', set: [], missing: ['SMTP_HOST'] }),
    }));
    const h = require('../workers/queue/handlers');
    await expect(h.email({ kind: 'welcome', to: 'a@b.com' }))
      .resolves.toEqual({ sent: false, reason: 'SMTP_NOT_CONFIGURED' });
    jest.dontMock('../lib/email');
    jest.resetModules();
  });

  it('throws on an unknown email kind rather than dropping the message', async () => {
    jest.resetModules();
    jest.doMock('../lib/email', () => ({
      isConfigured: () => true,
      describeConfig: () => ({ state: 'configured', set: [], missing: [] }),
    }));
    const h = require('../workers/queue/handlers');
    await expect(h.email({ kind: 'nonsense' })).rejects.toThrow(/Unknown email job kind/);
    jest.dontMock('../lib/email');
    jest.resetModules();
  });

  it('turns a failed WhatsApp send into a thrown error so it retries', async () => {
    // The Twilio adapter returns {status:'failed'} rather than throwing.
    // Returning that unread would record a rejected message as a completed
    // job and never retry it.
    jest.resetModules();
    jest.doMock('../modules/notifications/notifications.service', () => ({
      send: jest.fn().mockResolvedValue({ status: 'failed', error: 'rate limited' }),
    }));
    const h = require('../workers/queue/handlers');
    await expect(h.whatsapp({ type: 'class_reminder', recipient: {}, data: {} }))
      .rejects.toThrow('rate limited');
    jest.resetModules();
  });
});
