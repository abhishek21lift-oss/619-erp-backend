// The transport must connect over IPv4, and why asserting the old option was
// worse than not testing it at all.
//
// No mail left the deploy for days. The boot verification failed with:
//
//   ESOCKET  connect ENETUNREACH 2606:4700:90:0:f225:a1af:129b:4ba1:587
//            - Local (:::0)
//
// smtp.hostinger.com publishes both an AAAA (that 2606:4700:… address) and an
// A (172.65.255.143), and the deploy reached for the AAAA. The container has
// no IPv6 route, so the attempt died before TLS or AUTH was ever reached.
//
// ── What this file used to do, and why it was harmful ─────────────────────
//
// It asserted `family: 4` was present in the options handed to nodemailer,
// with a header explaining that the option "is one line and invisible, so it
// is exactly the kind of thing a later refactor drops while everything still
// passes".
//
// The option does nothing. nodemailer 9.0.3 never reads `options.family` for
// connection selection — `connect()` rebuilds the socket options from scratch
// and drops it. What it actually does is resolve BOTH families, concatenate
// them, and pick one with `Math.random()`.
//
// So this file passed, continuously and green, for the entire fortnight
// production was failing — because it proved the code SAID something, not
// that it DID anything. 480 real sends failed permanently in that window.
// That is the specific failure mode being corrected here: the assertions
// below are about the connection nodemailer can actually make.
//
// The fix resolves the host to an IPv4 literal before building the transport.
// `resolveHostname()` short-circuits on an IP literal, so the random pick is
// unreachable — there is no longer a code path that can select an AAAA.

'use strict';
jest.mock('nodemailer');
jest.mock('dns', () => ({ promises: { resolve4: jest.fn() } }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORIGINAL = { ...process.env };
const CFG = {
  SMTP_HOST: 'smtp.hostinger.com',
  SMTP_USER: 'support@myptstudio.com',
  SMTP_PASS: 'x',
};

/** The A record smtp.hostinger.com actually publishes. */
const IPV4 = '172.65.255.143';

/**
 * @param env        extra process.env for this load
 * @param resolve4   how DNS should behave: resolves to a list, or rejects
 */
function load(env = {}, resolve4 = async () => [IPV4]) {
  process.env = { ...ORIGINAL, ...CFG, ...env };
  jest.resetModules();
  const nm = require('nodemailer');
  const dns = require('dns');
  dns.promises.resolve4 = jest.fn(resolve4);
  nm.createTransport = jest.fn(() => ({ verify: jest.fn(async () => true), sendMail: jest.fn(async () => ({})) }));
  return { email: require('../lib/email'), nm, dns, logger: require('../lib/logger') };
}

afterEach(() => { process.env = { ...ORIGINAL }; jest.resetModules(); });

describe('the host is resolved to IPv4 before the transport exists', () => {
  test('connects to the A record, and validates TLS against the hostname', async () => {
    const { email, nm, dns } = load({ SMTP_PORT: '587' });
    await email.verifyConnection();

    expect(dns.promises.resolve4).toHaveBeenCalledWith('smtp.hostinger.com');
    const opts = nm.createTransport.mock.calls[0][0];
    expect(opts.host).toBe(IPV4);
    // Mandatory, not decoration. smtp-connection derives servername as
    // `!net.isIP(host) ? host : false`, so an IP host with no explicit
    // servername means no SNI and certificate validation against an address.
    expect(opts.servername).toBe('smtp.hostinger.com');
  });

  test('nodemailer is left no opportunity to choose an address family', async () => {
    // The point of the fix. `resolveHostname()` returns immediately for an IP
    // literal ("nothing to do here"), so the resolve-both-then-Math.random()
    // path that produced the AAAA is never entered.
    const { email, nm } = load({ SMTP_PORT: '587' });
    await email.verifyConnection();

    const opts = nm.createTransport.mock.calls[0][0];
    expect(require('net').isIP(opts.host)).toBe(4);
    // And it must not go back to leaning on the option that never worked.
    expect(opts).not.toHaveProperty('family');
  });

  test('picks one address when the host publishes several', async () => {
    const { email, nm } = load({ SMTP_PORT: '587' }, async () => ['172.65.255.143', '104.18.0.1']);
    await email.verifyConnection();
    expect(nm.createTransport.mock.calls[0][0].host).toBe('172.65.255.143');
  });

  test('resolves once and reuses the transport', async () => {
    const { email, nm, dns } = load({ SMTP_PORT: '587' });
    await email.verifyConnection();
    await email.verifyConnection();
    expect(dns.promises.resolve4).toHaveBeenCalledTimes(1);
    expect(nm.createTransport).toHaveBeenCalledTimes(1);
  });

  test('concurrent senders share one resolution rather than racing', async () => {
    // getTransport() caches the in-flight PROMISE, so there is no window in
    // which a caller can be handed a transport that is not ready.
    const { email, nm, dns } = load({ SMTP_PORT: '587' });
    await Promise.all([email.verifyConnection(), email.verifyConnection(), email.verifyConnection()]);
    expect(dns.promises.resolve4).toHaveBeenCalledTimes(1);
    expect(nm.createTransport).toHaveBeenCalledTimes(1);
  });

  test('skips the lookup when SMTP_HOST is already an address', async () => {
    const { email, nm, dns } = load({ SMTP_HOST: '172.65.255.143', SMTP_PORT: '587' });
    await email.verifyConnection();
    expect(dns.promises.resolve4).not.toHaveBeenCalled();
    expect(nm.createTransport.mock.calls[0][0].host).toBe('172.65.255.143');
  });
});

describe('a DNS failure degrades instead of taking mail down', () => {
  test('falls back to the hostname without throwing', async () => {
    const { email, nm } = load({ SMTP_PORT: '587' }, async () => { throw new Error('ESERVFAIL'); });

    // Initialisation must survive it — mail being degraded must not stop a
    // studio taking check-ins.
    const r = await email.verifyConnection();
    expect(r.ok).toBe(true);

    const opts = nm.createTransport.mock.calls[0][0];
    expect(opts.host).toBe('smtp.hostinger.com');
    // Every other setting is untouched by the fallback.
    expect(opts).toMatchObject({
      port: 587,
      secure: false,
      servername: 'smtp.hostinger.com',
      auth: { user: 'support@myptstudio.com', pass: 'x' },
    });
  });

  test('treats a host with no A record as a fallback, not a crash', async () => {
    const { email, nm } = load({ SMTP_PORT: '587' }, async () => []);
    await expect(email.verifyConnection()).resolves.toMatchObject({ ok: true });
    expect(nm.createTransport.mock.calls[0][0].host).toBe('smtp.hostinger.com');
  });

  test('says so in the log, without leaking credentials', async () => {
    const { email, logger } = load({ SMTP_PORT: '587' }, async () => { throw new Error('ESERVFAIL'); });
    await email.verifyConnection();

    expect(logger.warn).toHaveBeenCalled();
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toMatch(/IPv4 resolution failed/);
    expect(logged).not.toMatch(/pass|secret|password/i);
  });

  test('retries the lookup on the next send rather than pinning for the process life', async () => {
    // A blip at boot must not condemn the process to the hostname — and so to
    // the random address pick — until someone restarts it.
    let attempt = 0;
    const { email, nm, dns } = load({ SMTP_PORT: '587' }, async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('ESERVFAIL');
      return [IPV4];
    });

    await email.verifyConnection();
    expect(nm.createTransport.mock.calls[0][0].host).toBe('smtp.hostinger.com');

    await email.verifyConnection();
    expect(dns.promises.resolve4).toHaveBeenCalledTimes(2);
    expect(nm.createTransport.mock.calls[1][0].host).toBe(IPV4);
  });

  test('logs the successful resolution too, so a healthy boot is provable', async () => {
    const { email, logger } = load({ SMTP_PORT: '587' });
    await email.verifyConnection();
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).toMatch(/resolved to IPv4/);
    expect(logged).toMatch(new RegExp(IPV4.replace(/\./g, '\\.')));
    expect(logged).not.toMatch(/pass|secret|password/i);
  });
});

describe('the TLS pairing is unchanged by the fix', () => {
  test('587 stays STARTTLS and 465 stays implicit TLS', async () => {
    // Guards against "fixing" this by forcing secure alongside the host swap.
    const a = load({ SMTP_PORT: '587' });
    await a.email.verifyConnection();
    expect(a.nm.createTransport.mock.calls[0][0]).toMatchObject({ port: 587, secure: false });

    const b = load({ SMTP_PORT: '465' });
    await b.email.verifyConnection();
    expect(b.nm.createTransport.mock.calls[0][0]).toMatchObject({ port: 465, secure: true });
  });

  test('465 gets the address and the hostname SNI as well', async () => {
    // Both ports resolved the same hostname to the same unreachable AAAA, so
    // fixing only the configured one fixes nothing the day somebody switches.
    const { email, nm } = load({ SMTP_PORT: '465' });
    await email.verifyConnection();
    expect(nm.createTransport.mock.calls[0][0]).toMatchObject({
      host: IPV4, servername: 'smtp.hostinger.com', port: 465, secure: true,
    });
  });
});

describe('diagnose() on an unreachable IPv6 address', () => {
  test('names IPv6 rather than blaming a blocked port', async () => {
    // The previous diagnosis caught ESOCKET and confidently said "some hosts
    // block outbound SMTP entirely", which is what sent this investigation
    // after the port instead of the address family. A wrong diagnosis is
    // worse than none — it is followed.
    const { email, nm } = load({ SMTP_PORT: '587' });
    nm.createTransport.mockReturnValue({
      verify: jest.fn(async () => {
        throw Object.assign(
          new Error('connect ENETUNREACH 2606:4700:90:0:f225:a1af:129b:4ba1:587 - Local (:::0)'),
          { code: 'ESOCKET' },
        );
      }),
    });

    const r = await email.verifyConnection();
    expect(r.ok).toBe(false);
    expect(r.diagnosis).toMatch(/IPv6/);
    expect(r.diagnosis).not.toMatch(/block outbound SMTP/);
  });

  test('a genuine ENETUNREACH without an IPv6 address is not called IPv6', async () => {
    const { email, nm } = load({ SMTP_PORT: '587' });
    nm.createTransport.mockReturnValue({
      verify: jest.fn(async () => {
        throw Object.assign(new Error('connect ENETUNREACH 172.65.255.143:587'), { code: 'ENETUNREACH' });
      }),
    });

    const r = await email.verifyConnection();
    expect(r.diagnosis).toMatch(/No route/);
    expect(r.diagnosis).not.toMatch(/IPv6/);
  });

  test('a real timeout on an IPv4 address still reads as a port problem', async () => {
    // The port diagnosis is still correct for the case it was written for.
    const { email, nm } = load({ SMTP_PORT: '465' });
    nm.createTransport.mockReturnValue({
      verify: jest.fn(async () => {
        throw Object.assign(new Error('connect ETIMEDOUT 172.65.255.143:465'), { code: 'ETIMEDOUT' });
      }),
    });

    const r = await email.verifyConnection();
    expect(r.diagnosis).toMatch(/port 465|block outbound/i);
  });
});

describe('sendWithRetry is unchanged by the resolution work', () => {
  // The transport is now awaited INSIDE the retry loop. That must not have
  // altered how many attempts a send gets, which errors are retried, or what
  // is thrown at the end.
  const transient = () => Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
  const permanent = () => Object.assign(new Error('550 no such user'), { responseCode: 550 });

  test('still makes three attempts before giving up', async () => {
    const { email, nm } = load({ SMTP_PORT: '587' });
    const sendMail = jest.fn(async () => { throw transient(); });
    nm.createTransport.mockReturnValue({ verify: jest.fn(async () => true), sendMail });

    await expect(email.sendWithRetry({ to: 'a@b.c' }, { kind: 'test' })).rejects.toThrow('Connection timeout');
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  test('still stops immediately on a permanent rejection', async () => {
    // Retrying a 5xx is three bounces against the sending domain, not one.
    const { email, nm } = load({ SMTP_PORT: '587' });
    const sendMail = jest.fn(async () => { throw permanent(); });
    nm.createTransport.mockReturnValue({ verify: jest.fn(async () => true), sendMail });

    await expect(email.sendWithRetry({ to: 'a@b.c' })).rejects.toThrow('550 no such user');
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('still succeeds on a later attempt', async () => {
    const { email, nm } = load({ SMTP_PORT: '587' });
    let n = 0;
    const sendMail = jest.fn(async () => {
      n += 1;
      if (n < 3) throw transient();
      return { messageId: 'ok' };
    });
    nm.createTransport.mockReturnValue({ verify: jest.fn(async () => true), sendMail });

    await expect(email.sendWithRetry({ to: 'a@b.c' })).resolves.toMatchObject({ messageId: 'ok' });
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  test('resolves DNS once across all three attempts', async () => {
    // Awaiting the transport per attempt must not mean a lookup per attempt:
    // the promise is cached, so the retries reuse the pinned transport.
    const { email, nm, dns } = load({ SMTP_PORT: '587' });
    nm.createTransport.mockReturnValue({
      verify: jest.fn(async () => true),
      sendMail: jest.fn(async () => { throw transient(); }),
    });

    await expect(email.sendWithRetry({ to: 'a@b.c' })).rejects.toThrow();
    expect(dns.promises.resolve4).toHaveBeenCalledTimes(1);
  });

  test('the final failure is still logged, without the message body', async () => {
    const { email, nm, logger } = load({ SMTP_PORT: '587' });
    nm.createTransport.mockReturnValue({
      verify: jest.fn(async () => true),
      sendMail: jest.fn(async () => { throw transient(); }),
    });

    await expect(
      email.sendWithRetry({ to: 'a@b.c', html: '<p>reset token 12345</p>' }, { kind: 'password_reset' }),
    ).rejects.toThrow();

    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toMatch(/email send failed permanently/);
    expect(logged).toMatch(/password_reset/);
    // The diagnosis must never carry the message itself.
    expect(logged).not.toMatch(/reset token 12345/);
    expect(logged).not.toMatch(/"pass"/);
  });
});
