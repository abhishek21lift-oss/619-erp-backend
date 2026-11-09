// Three sessions in one browser.
//
// Trainer, member and platform accounts now each have their own cookie
// namespace (`<portal>_token`, `<portal>_refresh`), so signing in at one door
// no longer overwrites or revokes another. The `X-Portal` header only SELECTS
// which namespace to read; it is never an authorization fact — role and
// audience checks still run.
//
// These tests mount the real auth middleware and the real routes. The pool is
// the only fake, and it models refresh_tokens as rows so a revoked token and
// a live one are distinguishable.

'use strict';

process.env.JWT_SECRET = 's'.repeat(64);
process.env.DATABASE_URL = 'postgres://test';
process.env.NODE_ENV = 'test';
process.env.TENANT_RLS_ENFORCE = 'off';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

let mockUsers;  // id -> user row
let mockTokens; // [{ user_id, token_hash, expires_at, audience, revoked_at }]

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();

    if (/^INSERT INTO refresh_tokens/i.test(q)) {
      mockTokens.push({
        user_id: params[0],
        token_hash: params[1],
        expires_at: params[2],
        audience: params[3] ?? null,
        revoked_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    // Rotation claim and logout both revoke one row.
    if (/^UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE token_hash/i.test(q)) {
      const t = mockTokens.find((x) => x.token_hash === params[0] && x.revoked_at === null);
      if (t) t.revoked_at = new Date();
      return { rows: [], rowCount: t ? 1 : 0 };
    }

    if (/FROM refresh_tokens rt JOIN users u/i.test(q)) {
      const t = mockTokens.find(
        (x) => x.token_hash === params[0] && x.revoked_at === null && new Date(x.expires_at) > new Date()
      );
      if (!t) return { rows: [] };
      const u = mockUsers[t.user_id];
      return {
        rows: [{
          user_id: t.user_id, audience: t.audience, role: u.role,
          organization_id: u.organization_id, token_version: u.token_version,
          is_active: u.is_active, deleted_at: null,
        }],
      };
    }

    if (/LOWER\(u\.email\)/i.test(q)) {
      const u = Object.values(mockUsers).find(
        (x) => x.email.toLowerCase() === String(params[0]).toLowerCase()
      );
      return { rows: u ? [u] : [] };
    }

    // middleware/auth.js user reload.
    if (/FROM users u/i.test(q)) {
      const u = mockUsers[params[0]];
      return { rows: u ? [u] : [] };
    }

    if (/FROM user_profiles/i.test(q)) return { rows: [] };
    if (/^UPDATE users SET last_login/i.test(q)) return { rows: [], rowCount: 1 };

    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
}));

jest.mock('../lib/loginEvents', () => {
  const actual = jest.requireActual('../lib/loginEvents');
  return { ...actual, record: jest.fn() };
});
jest.mock('../lib/email', () => ({ sendPasswordReset: jest.fn(async () => ({ sent: true })) }));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'JBSWY3DPEHPK3PXP'),
  verifySync: jest.fn(() => ({ valid: false })),
}));

const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const { auth, invalidateUserCache } = require('../middleware/auth');

const PASSWORD = 'Str0ng!pass';
let HASH;

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use('/api/auth', require('../routes/auth'));
  // A plain tenant route, for the bearer-token case the /me guard short-circuits.
  a.get('/api/protected', auth, (req, res) => res.json({ id: req.user.id, portal: req.portal }));
  return a;
}

/** Set-Cookie header as a name → value map (cleared cookies come back ''). */
function jar(res) {
  const out = {};
  for (const line of res.headers['set-cookie'] || []) {
    const pair = line.split(';')[0];
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
  }
  return out;
}

function setCookieNames(res) {
  return (res.headers['set-cookie'] || []).map((line) => line.split('=')[0]);
}

const cookieHeader = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');

async function signIn(portal, email) {
  const res = await request(app()).post('/api/auth/login').send({ email, password: PASSWORD, portal });
  expect(res.status).toBe(200);
  return { res, cookies: jar(res) };
}

const me = (cookies, portal) =>
  request(app()).get('/api/auth/me').set('Cookie', cookieHeader(cookies)).set('X-Portal', portal);

const refresh = (cookies, portal) =>
  request(app()).post('/api/auth/refresh').set('Cookie', cookieHeader(cookies)).set('X-Portal', portal);

const accessToken = (cookies) => jwt.decode(cookies.trainer_token || cookies.member_token || cookies.platform_token);

function mintAccess(user, aud, { expired = false } = {}) {
  return jwt.sign(
    { id: user.id, token_version: user.token_version, aud },
    process.env.JWT_SECRET,
    { expiresIn: expired ? -1 : '15m' }
  );
}

const TRAINER = 'usr-trainer';
const MEMBER = 'usr-member';
const OWNER = 'usr-owner';

beforeAll(async () => { HASH = await bcrypt.hash(PASSWORD, 4); });

beforeEach(() => {
  mockTokens = [];
  invalidateUserCache();
  mockUsers = {
    [TRAINER]: {
      id: TRAINER, name: 'Coach', email: 'coach@x.com', role: 'trainer',
      password: HASH, token_version: 1, trainer_id: null, member_id: null, pt_client_id: null,
      organization_id: 'org-a', organization_name: 'A Studio', organization_logo_url: null,
      is_founder: false, founder_number: null, is_active: true, avatar_url: null,
    },
    [MEMBER]: {
      id: MEMBER, name: 'Client', email: 'client@x.com', role: 'member',
      password: HASH, token_version: 1, trainer_id: TRAINER, member_id: 'm-1', pt_client_id: 'pt-1',
      organization_id: 'org-a', organization_name: 'A Studio', organization_logo_url: null,
      is_founder: false, founder_number: null, is_active: true, avatar_url: null,
    },
    [OWNER]: {
      id: OWNER, name: 'Operator', email: 'owner@x.com', role: 'super_admin',
      password: HASH, token_version: 1, trainer_id: null, member_id: null, pt_client_id: null,
      organization_id: null, organization_name: null, organization_logo_url: null,
      is_founder: false, founder_number: null, is_active: true, avatar_url: null,
    },
  };
});

describe('one browser, three sessions', () => {
  test('1. each door writes its own cookie namespace and the legacy mirror', async () => {
    const { cookies } = await signIn('trainer', 'coach@x.com');

    expect(Object.keys(cookies).sort()).toEqual(
      ['refresh_token', 'token', 'trainer_refresh', 'trainer_token'].sort()
    );
    expect(accessToken(cookies)).toMatchObject({ id: TRAINER, aud: 'tenant' });
  });

  test('2. a second door does not overwrite the first door\'s cookies', async () => {
    const trainerLogin = await signIn('trainer', 'coach@x.com');
    const memberLogin = await signIn('member', 'client@x.com');

    const memberNames = setCookieNames(memberLogin.res);
    expect(memberNames).toContain('member_token');
    expect(memberNames).not.toContain('trainer_token');
    expect(memberLogin.cookies).not.toHaveProperty('trainer_token');

    // Both identities resolve when the browser presents the merged jar.
    const merged = { ...trainerLogin.cookies, ...memberLogin.cookies };
    expect((await me(merged, 'trainer')).body.user.id).toBe(TRAINER);
    expect((await me(merged, 'member')).body.user.id).toBe(MEMBER);
  });

  test('3. logging out of one door leaves the other signed in', async () => {
    const trainerLogin = await signIn('trainer', 'coach@x.com');
    const memberLogin = await signIn('member', 'client@x.com');
    const merged = { ...trainerLogin.cookies, ...memberLogin.cookies };

    const out = await request(app()).post('/api/auth/logout')
      .set('Cookie', cookieHeader(merged)).set('X-Portal', 'trainer');

    expect(out.status).toBe(200);
    expect(setCookieNames(out)).toContain('trainer_token');
    expect(setCookieNames(out)).not.toContain('member_token');
    expect(setCookieNames(out)).not.toContain('member_refresh');

    // The member session and its refresh token are still live.
    expect((await me(merged, 'member')).status).toBe(200);
    expect((await refresh(merged, 'member')).status).toBe(200);
  });

  test('4. refreshing one door does not rotate or revoke the other', async () => {
    const trainerLogin = await signIn('trainer', 'coach@x.com');
    const memberLogin = await signIn('member', 'client@x.com');
    const merged = { ...trainerLogin.cookies, ...memberLogin.cookies };

    const rotated = await refresh(merged, 'trainer');
    expect(rotated.status).toBe(200);
    expect(setCookieNames(rotated)).toContain('trainer_refresh');
    expect(setCookieNames(rotated)).not.toContain('member_refresh');

    expect((await me(merged, 'member')).status).toBe(200);
    expect((await refresh(merged, 'member')).status).toBe(200);
  });
});

describe('one door\'s failure stays at that door', () => {
  test('5. an expired trainer access token does not affect the member door', async () => {
    const trainerLogin = await signIn('trainer', 'coach@x.com');
    const memberLogin = await signIn('member', 'client@x.com');
    const stale = { ...trainerLogin.cookies, trainer_token: mintAccess(mockUsers[TRAINER], 'tenant', { expired: true }) };
    const merged = { ...stale, ...memberLogin.cookies };

    expect((await me(merged, 'trainer')).status).toBe(401);
    expect((await me(merged, 'member')).status).toBe(200);
  });

  test('6. a token copied into another door\'s cookie is refused', async () => {
    const trainerLogin = await signIn('trainer', 'coach@x.com');
    const memberLogin = await signIn('member', 'client@x.com');

    // The trainer's access token under the member door's cookie name.
    expect((await me(
      { member_token: trainerLogin.cookies.trainer_token }, 'member'
    )).status).toBe(401);

    // And the other way around.
    expect((await me(
      { trainer_token: memberLogin.cookies.member_token }, 'trainer'
    )).status).toBe(401);
  });

  test('7. a refresh token presented at the wrong door is refused', async () => {
    const trainerLogin = await signIn('trainer', 'coach@x.com');

    expect((await refresh({ member_refresh: trainerLogin.cookies.trainer_refresh }, 'member')).status).toBe(401);

    // The legitimate door still works afterwards.
    expect((await refresh(
      { trainer_refresh: trainerLogin.cookies.trainer_refresh }, 'trainer'
    )).status).toBe(200);
  });

  test('8. revoking one account\'s token_version does not touch the other door', async () => {
    const trainerLogin = await signIn('trainer', 'coach@x.com');
    const memberLogin = await signIn('member', 'client@x.com');

    mockUsers[TRAINER].token_version += 1;
    invalidateUserCache();

    const merged = { ...trainerLogin.cookies, ...memberLogin.cookies };
    expect((await me(merged, 'trainer')).status).toBe(401);
    expect((await me(merged, 'member')).status).toBe(200);
  });
});

describe('a pre-namespace session migrates once, at its own door', () => {
  test('9. the legacy pair is recognised and refreshed into its portal namespace', async () => {
    const legacy = (await signIn('trainer', 'coach@x.com')).cookies;
    const legacyOnly = { token: legacy.token, refresh_token: legacy.refresh_token };

    // /me does not claim the session yet — it tells the app a migration is due.
    const probe = await me(legacyOnly, 'trainer');
    expect(probe.status).toBe(200);
    expect(probe.body).toEqual({ user: null, legacy: true });

    const migrated = await refresh(legacyOnly, 'trainer');
    expect(migrated.status).toBe(200);
    const cookies = jar(migrated);
    expect(cookies).toHaveProperty('trainer_token');
    expect(cookies).toHaveProperty('trainer_refresh');

    expect((await me(cookies, 'trainer')).body.user.id).toBe(TRAINER);
  });

  test('10. a legacy session at the wrong door is not migrated or signed out', async () => {
    const legacy = (await signIn('trainer', 'coach@x.com')).cookies;
    const legacyOnly = { token: legacy.token, refresh_token: legacy.refresh_token };

    const probe = await me(legacyOnly, 'member');
    expect(probe.body).toEqual({ user: null, legacy: true });

    // The member door must refuse to refresh the trainer's session...
    const crossed = await refresh(legacyOnly, 'member');
    expect(crossed.status).toBe(401);
    // ...without destroying it. This is the difference between "not my
    // session" and "sign this person out everywhere".
    expect(setCookieNames(crossed)).not.toContain('refresh_token');
    expect(setCookieNames(crossed)).not.toContain('token');

    // The trainer's legacy session still migrates at its own door.
    expect((await refresh(legacyOnly, 'trainer')).status).toBe(200);
  });
});

describe('the platform plane is never downgraded', () => {
  test('11. a platform refresh returns a platform token, not a tenant one', async () => {
    const login = await signIn('platform', 'owner@x.com');
    expect(accessToken(login.cookies)).toMatchObject({ id: OWNER, aud: 'platform' });

    const rotated = await refresh({ platform_refresh: login.cookies.platform_refresh }, 'platform');
    expect(rotated.status).toBe(200);
    expect(accessToken(jar(rotated))).toMatchObject({ id: OWNER, aud: 'platform' });
  });

  test('12. a platform refresh token cannot be spent at a tenant door', async () => {
    const login = await signIn('platform', 'owner@x.com');
    expect((await refresh({ trainer_refresh: login.cookies.platform_refresh }, 'trainer')).status).toBe(401);
  });
});

describe('the unified door restores whichever tenant session is present', () => {
  test('unified member login is found by /me with no X-Portal', async () => {
    const { res, cookies } = await signIn('unified', 'client@x.com');
    expect(setCookieNames(res)).toContain('member_token');

    const neutral = await request(app()).get('/api/auth/me')
      .set('Cookie', cookieHeader(cookies));

    expect(neutral.status).toBe(200);
    expect(neutral.body.user.id).toBe(MEMBER);
  });

  test('refresh with no X-Portal selects the member refresh cookie', async () => {
    const { cookies } = await signIn('unified', 'client@x.com');

    const rotated = await request(app()).post('/api/auth/refresh')
      .set('Cookie', cookieHeader(cookies));

    expect(rotated.status).toBe(200);
    expect(setCookieNames(rotated)).toContain('member_token');
  });
});

describe('the portal header selects, it does not authorize', () => {
  test('a bearer token is not bound to a portal cookie namespace', async () => {
    const login = await signIn('trainer', 'coach@x.com');
    const res = await request(app()).get('/api/protected')
      .set('Authorization', `Bearer ${login.cookies.trainer_token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: TRAINER, portal: null });
  });

  test('naming a portal does not admit an account that does not belong to it', async () => {
    // A member access token in the member namespace, but the account is
    // disabled: the namespace agrees, the account does not.
    const memberLogin = await signIn('member', 'client@x.com');
    mockUsers[MEMBER].is_active = false;
    invalidateUserCache();

    expect((await me({ member_token: memberLogin.cookies.member_token }, 'member')).status).toBe(401);
  });
});
