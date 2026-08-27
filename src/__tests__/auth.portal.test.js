// Two sign-in doors, and the rule that keeps them apart.
//
// Admin Login (/login) is for the people who run a studio. Member Login
// (/member-login) is for clients. Each refuses the other's accounts.
//
// The whole point of these tests is that the separation is NOT the two pages.
// Both post to the same endpoint, so a member who opens Admin Login, or anyone
// with curl, reaches exactly the same handler. If the rule is not here it does
// not exist.

const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

// routes/auth.js requires otplib, whose CJS build pulls in @scure/base — ESM
// that Jest will not parse. Stubbed out exactly as auth.login.test.js and
// auth.forgotPassword.test.js do; the real module is exercised by
// otplib.contract.test.js under plain Node. Nothing here touches TOTP.
jest.mock('otplib', () => ({
  verifySync: jest.fn(() => false),
  authenticator: { verify: jest.fn(() => false), generateSecret: jest.fn(() => 'S') },
}));

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../lib/loginEvents', () => {
  const actual = jest.requireActual('../lib/loginEvents');
  return { ...actual, record: jest.fn() };
});

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const loginEvents = require('../lib/loginEvents');

const app = express();
app.use(express.json());
app.use('/api/auth', require('../routes/auth'));

const PASSWORD = 'Str0ng!pass';
let HASH;
beforeAll(async () => { HASH = await bcrypt.hash(PASSWORD, 4); });

/** A users row as the login query returns it. */
const row = (role, over = {}) => ({
  id: `usr-${role}`, name: 'Somebody', email: 'a@b.com', role,
  password: HASH, token_version: 0, trainer_id: null, member_id: null,
  is_active: true, organization_id: 'org-a', organization_name: 'A Studio',
  ...over,
});

const signIn = (body) => request(app).post('/api/auth/login').send({
  email: 'a@b.com', password: PASSWORD, ...body,
});

beforeEach(() => {
  pool.query.mockReset();
  loginEvents.record.mockClear();
});

describe('Member Login refuses studio accounts', () => {
  it.each(['admin', 'trainer', 'manager', 'super_admin'])('refuses %s', async (role) => {
    pool.query.mockResolvedValueOnce({ rows: [row(role)] });

    const res = await signIn({ portal: 'member' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('WRONG_PORTAL');
    // No session is issued on the way out.
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.user).toBeUndefined();
  });

  it('admits a member', async () => {
    pool.query.mockResolvedValue({ rows: [row('member')] });
    const res = await signIn({ portal: 'member' });
    expect(res.status).toBe(200);
  });
});

describe('Admin Login refuses member accounts', () => {
  it('refuses a member', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row('member')] });

    const res = await signIn({ portal: 'staff' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('WRONG_PORTAL');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it.each(['admin', 'trainer', 'manager'])('admits %s', async (role) => {
    pool.query.mockResolvedValue({ rows: [row(role)] });
    const res = await signIn({ portal: 'staff' });
    expect(res.status).toBe(200);
  });
});

describe('the check is not something the client can skip', () => {
  it('refuses a member when portal is omitted entirely', async () => {
    // The default matters more than the explicit values. A member posting
    // straight to the endpoint — no portal field, no browser, no page — must
    // still be refused, or the two doors are a decoration on one open one.
    pool.query.mockResolvedValueOnce({ rows: [row('member')] });
    const res = await signIn({});
    expect(res.status).toBe(403);
  });

  it('refuses a member when portal is a junk value', async () => {
    // Anything that is not exactly 'member' is treated as staff. Written that
    // way round on purpose: an unrecognised value must fall to the stricter
    // side, not become a way to opt out of the check.
    //
    // Honest note: today the zod enum rejects junk with a 400 before the
    // handler sees it, so `req.body.portal === 'member' ? … : 'staff'` and a
    // looser `req.body.portal || 'staff'` behave identically and no test can
    // tell them apart. The strict form is kept anyway — if the enum is ever
    // widened or dropped, the loose form would let an unrecognised value match
    // NEITHER branch and sail straight past both checks, for any role.
    pool.query.mockResolvedValueOnce({ rows: [row('member')] });
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'a@b.com', password: PASSWORD, portal: 'anything' });
    expect([400, 403]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it('still lets staff in when portal is omitted, so existing callers keep working', async () => {
    // The mobile app on /api/v1/auth/login and every saved bookmark send no
    // portal. They must behave exactly as before this change.
    pool.query.mockResolvedValue({ rows: [row('admin')] });
    const res = await signIn({});
    expect(res.status).toBe(200);
  });
});

describe('the wrong door does not become an account oracle', () => {
  it('says nothing different for a wrong password on the wrong portal', async () => {
    // The reason the portal check runs AFTER bcrypt. If it ran first, sending
    // any address with a junk password would distinguish "no such account"
    // from "exists, and is staff" — handing an attacker a way to enumerate
    // both membership and role without ever knowing a password.
    pool.query.mockResolvedValueOnce({ rows: [row('admin')] });
    const wrongPw = await request(app).post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'not-the-password', portal: 'member' });

    pool.query.mockResolvedValueOnce({ rows: [] });
    const noSuchUser = await request(app).post('/api/auth/login')
      .send({ email: 'nobody@b.com', password: 'not-the-password', portal: 'member' });

    expect(wrongPw.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(wrongPw.body).toEqual(noSuchUser.body);
  });

  it('only reveals the mismatch once the password is proven', async () => {
    // With the correct password the caller already owns the account, so
    // telling them which door to use leaks nothing they do not know.
    pool.query.mockResolvedValueOnce({ rows: [row('admin')] });
    const res = await signIn({ portal: 'member' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/Admin Login/);
  });
});

describe('the audit trail', () => {
  // Asserted for BOTH branches. The first version of this only covered a
  // member on Admin Login, and a mutation that mislabelled the other branch —
  // staff on Member Login — sailed through. Two near-identical branches need
  // two assertions, or one of them is unguarded.

  it('records a member on Admin Login as wrong_portal, not bad_password', async () => {
    // The credentials were correct. Filing it under bad_password would make an
    // ordinary mix-up look like an attack, and drown the real signal if one
    // ever appeared.
    pool.query.mockResolvedValueOnce({ rows: [row('member')] });
    await signIn({ portal: 'staff' });

    expect(loginEvents.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'wrong_portal', userId: 'usr-member' }),
    );
  });

  it('records staff on Member Login as wrong_portal too', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row('admin')] });
    await signIn({ portal: 'member' });

    expect(loginEvents.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'wrong_portal', userId: 'usr-admin' }),
    );
  });

  it('never files a wrong-door attempt as a failed credential', async () => {
    // Stated as a negative as well, because both branches passing the
    // positive check above would still allow an extra bad_password record
    // alongside it — which is what would actually pollute the audit trail.
    for (const [role, portal] of [['member', 'staff'], ['admin', 'member']]) {
      loginEvents.record.mockClear();
      pool.query.mockResolvedValueOnce({ rows: [row(role)] });
      await signIn({ portal });

      const outcomes = loginEvents.record.mock.calls.map((c) => c[1].outcome);
      expect([role, outcomes.includes('bad_password')]).toEqual([role, false]);
    }
  });
});

describe('the Command Center door', () => {
  // ── Why these post a real request ────────────────────────────────────────
  //
  // The platform door shipped broken. routes/auth.js understood
  // portal:'platform', the frontend sent it, the TypeScript type allowed it —
  // and lib/validation.js still declared z.enum(['staff','member']), so
  // validate() answered 400 "Invalid request" before the handler ran. The new
  // sign-in page was unusable from the moment it deployed.
  //
  // Every test covering the platform door asserted on the handler's SOURCE
  // (`expect(src).toMatch(/portal === 'platform'/)`), which is true of code
  // that never executes. These go through the mounted router, so the schema
  // and the handler cannot drift apart again without something failing.

  it('accepts portal=platform through the request validator', () => {
    // The regression itself, stated as narrowly as possible: whatever the
    // outcome of the sign-in, it must not be a schema rejection.
    pool.query.mockResolvedValueOnce({ rows: [row('super_admin', { organization_id: null })] });
    pool.query.mockResolvedValue({ rows: [] });
    return signIn({ portal: 'platform' }).then((res) => {
      expect(res.status).not.toBe(400);
      expect(res.body?.error?.code).not.toBe('VALIDATION');
    });
  });

  it('signs a platform operator in', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row('super_admin', { organization_id: null })] });
    pool.query.mockResolvedValue({ rows: [] });
    const res = await signIn({ portal: 'platform' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('super_admin');
  });

  it('refuses a studio account at the Command Center door', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row('admin')] });
    pool.query.mockResolvedValue({ rows: [] });
    const res = await signIn({ portal: 'platform' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('WRONG_PORTAL');
    expect(res.body.error.portal).toBe('staff');
  });

  it('refuses a client at the Command Center door, pointing at the member door', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row('member')] });
    pool.query.mockResolvedValue({ rows: [] });
    const res = await signIn({ portal: 'platform' });
    expect(res.status).toBe(403);
    expect(res.body.error.portal).toBe('member');
  });

  it('rejects a portal nobody implements, rather than silently treating it as staff', async () => {
    // The other side of widening the enum: it must widen by exactly one value.
    const res = await signIn({ portal: 'nonsense' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('still accepts every door the schema declares', async () => {
    // Guards the specific failure mode: a value the handler knows about that
    // the schema has never heard of. Posting each one proves the two agree.
    for (const portal of ['staff', 'member', 'platform']) {
      pool.query.mockReset();
      pool.query.mockResolvedValueOnce({ rows: [] });   // no such user
      pool.query.mockResolvedValue({ rows: [] });
      const res = await signIn({ portal });
      // 401 (unknown email) is fine — it means the request got PAST validation
      // and into the handler, which is the only thing being asserted here.
      expect([portal, res.body?.error?.code]).not.toEqual([portal, 'VALIDATION']);
    }
  });
});
