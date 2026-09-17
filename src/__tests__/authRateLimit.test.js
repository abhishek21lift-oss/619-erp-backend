'use strict';
// Rate limiting on the credential endpoints, and the studio lockout it fixes.
//
// ── The bug, stated as the test that was missing ───────────────────────────
//
// One limiter instance guarded login, google-login and refresh, keyed on the
// IP, thirty per fifteen minutes. A gym has one public IP. Every trainer,
// receptionist and manager in the building shared those thirty — and because
// the same instance guarded refresh, every signed-in member of staff spent at
// least one of them per window automatically, renewing a 15-minute access
// token without touching a keyboard.
//
// Ten staff on shift therefore consumed the studio's ability to SIGN IN
// through renewals alone, and the 429 said "too many login attempts" to people
// who had not attempted a login.
//
// Nothing tested it, because from a single test client the old limiter looked
// perfectly correct: one IP, thirty requests, thirty-first refused. The defect
// only appears when the test has more than one person in it.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const express = require('express');
const request = require('supertest');

/**
 * An app mounting the real limiters in front of a handler whose outcome the
 * test chooses, so "a failed sign-in" is a real 401 through the real
 * middleware rather than a simulated one.
 *
 * Rebuilt per test via resetModules so each starts with empty counters — the
 * limiters hold their state in module scope, and a shared instance would make
 * every test depend on the order of the ones before it.
 */
function buildApp({ outcome = 401 } = {}) {
  jest.resetModules();
  const {
    loginIdentityLimiter, loginIpLimiter, refreshLimiter, limits,
  } = require('../middleware/authRateLimit');

  const app = express();
  app.use(express.json());
  // Parsed the way server.js does, because deviceOf reads req.cookies.
  app.use((req, _res, next) => {
    const raw = req.headers.cookie || '';
    req.cookies = Object.fromEntries(
      raw.split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2)
    );
    next();
  });
  // One fixed address unless a test overrides it — the shared-studio case.
  app.set('trust proxy', true);

  app.post('/login', loginIdentityLimiter, loginIpLimiter, (req, res) =>
    res.status(outcome).json({ ok: outcome < 400 }));
  app.post('/refresh', refreshLimiter, (req, res) => res.status(200).json({ ok: true }));

  return { app, limits };
}

const STUDIO_IP = '203.0.113.7';

/** One failed sign-in from the studio's address. */
const failLogin = (app, email, ip = STUDIO_IP) =>
  request(app).post('/login').set('X-Forwarded-For', ip).send({ email, password: 'wrong' });

describe('a shared studio address does not lock the studio out', () => {
  // The regression, stated directly. Twelve people, one IP, each getting their
  // own password wrong twice — 24 failures, four fewer than the old shared
  // budget of thirty, so under the OLD limiter the thirteenth person's first
  // honest attempt was already inside the danger zone and the next few were
  // refused outright.
  it('twelve staff each failing twice are all still able to try again', async () => {
    const { app } = buildApp();
    const staff = Array.from({ length: 12 }, (_, i) => `staff${i}@gym.example`);

    for (const email of staff) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await failLogin(app, email);
        expect(res.status).toBe(401);
      }
    }

    // A thirteenth person, same building, first attempt of the day.
    const newcomer = await failLogin(app, 'manager@gym.example');
    expect(newcomer.status).toBe(401);
  });

  it('one account being attacked does not spend anybody else\'s budget', async () => {
    const { app, limits } = buildApp();

    // Burn the victim's entire per-account budget from the studio address.
    for (let i = 0; i < limits.LOGIN_FAILURES_PER_IDENTITY; i += 1) {
      await failLogin(app, 'victim@gym.example');
    }
    const victimBlocked = await failLogin(app, 'victim@gym.example');
    expect(victimBlocked.status).toBe(429);
    expect(victimBlocked.body.scope).toBe('identity');

    // A colleague on the same IP is unaffected — the point of the identity
    // dimension existing at all.
    const colleague = await failLogin(app, 'colleague@gym.example');
    expect(colleague.status).toBe(401);
  });
});

describe('renewals no longer consume the ability to sign in', () => {
  // The half that made the lockout certain rather than merely likely. Refresh
  // shared the login limiter INSTANCE, so it shared the counter.
  it('a device renewing its token many times does not affect login', async () => {
    const { app, limits } = buildApp();

    for (let i = 0; i < limits.REFRESH_PER_DEVICE; i += 1) {
      const res = await request(app).post('/refresh')
        .set('X-Forwarded-For', STUDIO_IP)
        .set('Cookie', 'refresh_token=device-one-token')
        .send({});
      expect(res.status).toBe(200);
    }

    const login = await failLogin(app, 'anyone@gym.example');
    expect(login.status).toBe(401);
  });

  it('each device has its own renewal budget', async () => {
    const { app, limits } = buildApp();
    const renew = (token) => request(app).post('/refresh')
      .set('X-Forwarded-For', STUDIO_IP)
      .set('Cookie', `refresh_token=${token}`)
      .send({});

    for (let i = 0; i < limits.REFRESH_PER_DEVICE; i += 1) await renew('device-a');
    const aBlocked = await renew('device-a');
    expect(aBlocked.status).toBe(429);
    expect(aBlocked.body.scope).toBe('device');

    // Same building, same address, different phone.
    const b = await renew('device-b');
    expect(b.status).toBe(200);
  });
});

describe('brute-force protection is stronger, not weaker', () => {
  it('stops a single account after its failure budget, wherever it comes from', async () => {
    const { app, limits } = buildApp();

    // Rotating the source address, which is what defeats an IP-only limiter.
    for (let i = 0; i < limits.LOGIN_FAILURES_PER_IDENTITY; i += 1) {
      await failLogin(app, 'owner@gym.example', `198.51.100.${i + 1}`);
    }

    const blocked = await failLogin(app, 'owner@gym.example', '198.51.100.250');
    expect(blocked.status).toBe(429);
    expect(blocked.body.scope).toBe('identity');
  });

  it('treats one address working through many accounts as stuffing', async () => {
    const { app, limits } = buildApp();

    // Every attempt a different account, so the identity buckets never fill —
    // only the address ceiling can catch this shape.
    for (let i = 0; i < limits.LOGIN_FAILURES_PER_IP; i += 1) {
      await failLogin(app, `target${i}@gym.example`, '198.51.100.9');
    }

    const blocked = await failLogin(app, 'one-more@gym.example', '198.51.100.9');
    expect(blocked.status).toBe(429);
    expect(blocked.body.scope).toBe('address');
  });

  it('capitalisation does not buy a fresh budget', async () => {
    const { app, limits } = buildApp();
    // The login query matches on LOWER(u.email); if the limiter did not, an
    // attacker would get a new allowance per spelling.
    for (let i = 0; i < limits.LOGIN_FAILURES_PER_IDENTITY; i += 1) {
      await failLogin(app, 'Owner@Gym.Example');
    }

    const blocked = await failLogin(app, 'owner@gym.example');
    expect(blocked.status).toBe(429);
  });

  it('a successful sign-in costs nothing', async () => {
    // skipSuccessfulRequests — what lets the per-account ceiling be stricter
    // than the old shared one without tripping on ordinary use.
    const { app, limits } = buildApp({ outcome: 200 });

    for (let i = 0; i < limits.LOGIN_FAILURES_PER_IDENTITY * 3; i += 1) {
      const res = await request(app).post('/login')
        .set('X-Forwarded-For', STUDIO_IP)
        .send({ email: 'busy@gym.example', password: 'right' });
      expect(res.status).toBe(200);
    }
  });
});

describe('the 429 tells the caller something true', () => {
  it('carries Retry-After and a matching body field', async () => {
    const { app, limits } = buildApp();
    for (let i = 0; i < limits.LOGIN_FAILURES_PER_IDENTITY; i += 1) {
      await failLogin(app, 'blocked@gym.example');
    }

    const res = await failLogin(app, 'blocked@gym.example');
    expect(res.status).toBe(429);

    const header = Number(res.headers['retry-after']);
    expect(header).toBeGreaterThan(0);
    // A client that retries immediately spends the next window on the way in,
    // so the header has to be real rather than a constant.
    expect(header).toBeLessThanOrEqual(limits.WINDOW_MS / 1000);
    expect(res.body.retry_after_seconds).toBe(header);
  });

  it('reveals nothing about whether the account exists', async () => {
    const { app, limits } = buildApp();
    const burn = async (email) => {
      for (let i = 0; i < limits.LOGIN_FAILURES_PER_IDENTITY; i += 1) await failLogin(app, email);
      return failLogin(app, email);
    };

    // The identity bucket counts failures against whatever string was typed,
    // real account or not — so both must answer identically.
    const real = await burn('owner@gym.example');
    const fictional = await burn('nobody-at-all@gym.example');
    expect(fictional.status).toBe(real.status);
    expect(fictional.body).toEqual(real.body);
  });
});

describe('keys carry no secrets', () => {
  const { identityOf, deviceOf } = require('../middleware/authRateLimit');

  it('an email never appears in its own rate-limit key', () => {
    const key = identityOf({ body: { email: 'owner@gym.example' } });
    expect(key).not.toContain('owner');
    expect(key).not.toContain('@');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a refresh token never appears in its own rate-limit key', () => {
    // It is a live credential. A key name is not a place to keep one — Redis
    // keys are readable by anything with Redis access and turn up in dumps.
    const raw = 'super-secret-refresh-token-value';
    const key = deviceOf({ cookies: { refresh_token: raw }, ip: '203.0.113.7' });
    expect(key).not.toContain(raw);
    expect(key).toMatch(/^d:[0-9a-f]{32}$/);
  });

  it('falls back to the address when no token is presented', () => {
    expect(deviceOf({ cookies: {}, ip: '203.0.113.7' })).toBe('ip:203.0.113.7');
  });
});

describe('concurrency', () => {
  // A limiter whose check and increment are not atomic lets N simultaneous
  // requests all read "under the limit" and all proceed. The budget then means
  // nothing to exactly the traffic that arrives fastest, which is the attack.
  it('parallel failures consume exactly the budget, not more', async () => {
    const { app, limits } = buildApp();
    const budget = limits.LOGIN_FAILURES_PER_IDENTITY;
    const overshoot = 15;

    const responses = await Promise.all(
      Array.from({ length: budget + overshoot }, () => failLogin(app, 'race@gym.example'))
    );

    const allowed = responses.filter((r) => r.status === 401).length;
    const refused = responses.filter((r) => r.status === 429).length;

    expect(allowed).toBe(budget);
    expect(refused).toBe(overshoot);
  });

  it('parallel renewals from different devices do not share a budget', async () => {
    const { app, limits } = buildApp();
    const renew = (token) => request(app).post('/refresh')
      .set('X-Forwarded-For', STUDIO_IP)
      .set('Cookie', `refresh_token=${token}`)
      .send({});

    // Two devices, each firing its whole budget at once from one address.
    const responses = await Promise.all([
      ...Array.from({ length: limits.REFRESH_PER_DEVICE }, () => renew('phone')),
      ...Array.from({ length: limits.REFRESH_PER_DEVICE }, () => renew('laptop')),
    ]);

    expect(responses.every((r) => r.status === 200)).toBe(true);
  });
});
