'use strict';
// MFA enrolment and the login challenge, at the route level.
//
// The enrolment endpoints and the Settings UI both already existed; what did
// not exist was any test holding the two halves of the contract together.
// The half that had silently come apart was recovery codes — issued at
// enrolment, never stored, and rejected at login as malformed — so these
// pin the whole path, not only the parts that were broken.
//
// Asserted on the SQL and the responses, with pool and auth mocked, matching
// the convention in ptOs.trainers.tenantIsolation.test.js next door.

const queries = [];
let mockQueryImpl = async (sql, params) => {
  queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  return { rows: [], rowCount: 0 };
};
jest.mock('../db/pool', () => ({
  query: jest.fn((...args) => mockQueryImpl(...args)),
  connect: jest.fn(),
}));

const logLines = [];
jest.mock('../lib/logger', () => ({
  info: (...a) => logLines.push(a),
  warn: (...a) => logLines.push(a),
  error: (...a) => logLines.push(a),
  debug: (...a) => logLines.push(a),
  fatal: (...a) => logLines.push(a),
}));

jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));

// otplib v13's CJS build requires @scure/base, which is ESM-only; Jest's
// resolver throws "Unexpected token 'export'" on it. Stubbed here following
// the convention in auth.forgotPassword.test.js — and, as the header of
// otplib.contract.test.js argues, a mock can only prove the code matches the
// mock, so the REAL library is exercised there instead, in a subprocess.
//
// `mockTotpValid` lets each test decide what the authenticator would say,
// which is the only thing this file needs from otplib.
let mockTotpValid = false;
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'JBSWY3DPEHPK3PXP'),
  verifySync: jest.fn(() => ({ valid: mockTotpValid })),
}));

const USER = { id: 'usr-sa', email: 'sa@example.test', role: 'super_admin', organization_id: null };
let mockUser = USER;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
  invalidateUserCache: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const recovery = require('../lib/mfaRecoveryCodes');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/profile', require('../routes/profile'));
  return a;
}

beforeEach(() => {
  queries.length = 0;
  logLines.length = 0;
  mockTotpValid = false;
  mockUser = { ...USER };
  mockQueryImpl = async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  };
});

describe('POST /api/profile/mfa/setup — enrolment', () => {
  test('returns a secret and a scannable otpauth URI', async () => {
    const res = await request(app()).post('/api/profile/mfa/setup');

    expect(res.status).toBe(200);
    expect(res.body.secret).toEqual(expect.any(String));
    expect(res.body.qrUrl).toMatch(/^otpauth:\/\/totp\//);
    // The URI has to carry the secret and name the issuer, or an authenticator
    // app shows an unlabelled entry the user cannot identify later.
    expect(res.body.qrUrl).toContain(`secret=${res.body.secret}`);
    expect(res.body.qrUrl).toContain(`issuer=${encodeURIComponent('MY PT STUDIO')}`);
    expect(res.body.qrUrl).toContain(encodeURIComponent('MY PT STUDIO') + ':');
    expect(res.body.qrUrl).toContain(encodeURIComponent(USER.email));
  });

  test('stores the secret but does NOT enable MFA yet', async () => {
    // The property the whole flow rests on: possession is not proven until a
    // code comes back. Enabling here would lock out anyone whose scan failed.
    await request(app()).post('/api/profile/mfa/setup');

    const write = queries.find((q) => /INSERT INTO user_profiles/i.test(q.sql));
    expect(write).toBeTruthy();
    expect(write.sql).toMatch(/mfa_secret/);
    expect(write.sql).not.toMatch(/mfa_enabled\s*=\s*TRUE/i);
  });

  test('re-running setup replaces the secret, so an abandoned attempt cannot linger', async () => {
    await request(app()).post('/api/profile/mfa/setup');
    const write = queries.find((q) => /INSERT INTO user_profiles/i.test(q.sql));
    expect(write.sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/i);
  });

  test('the secret never reaches the logs', async () => {
    const res = await request(app()).post('/api/profile/mfa/setup');
    expect(JSON.stringify(logLines)).not.toContain(res.body.secret);
  });
});

describe('POST /api/profile/mfa/verify — proving possession', () => {
  const SECRET = 'JBSWY3DPEHPK3PXP';

  function withSecret(extra = {}) {
    mockQueryImpl = async (sql, params) => {
      const clean = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: clean, params });
      if (/SELECT mfa_secret FROM user_profiles/i.test(clean)) {
        return { rows: [{ mfa_secret: SECRET }], rowCount: 1 };
      }
      for (const [pattern, fn] of Object.entries(extra)) {
        if (new RegExp(pattern, 'i').test(clean)) return fn();
      }
      return { rows: [], rowCount: 0 };
    };
  }

  test('rejects a non-numeric or wrong-length code without touching the database', async () => {
    const res = await request(app()).post('/api/profile/mfa/verify').send({ code: 'abcdef' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Valid MFA code is required/i);
    expect(queries.find((q) => /SELECT mfa_secret/i.test(q.sql))).toBeUndefined();
  });

  test('refuses verification when setup has not been run', async () => {
    // No secret stored: there is nothing to verify against, and answering
    // anything other than "set up first" would be misleading.
    const res = await request(app()).post('/api/profile/mfa/verify').send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/setup required/i);
  });

  test('rejects an invalid OTP and leaves MFA disabled', async () => {
    withSecret();
    const res = await request(app()).post('/api/profile/mfa/verify').send({ code: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid MFA code/i);
    expect(queries.find((q) => /mfa_enabled = TRUE/i.test(q.sql))).toBeUndefined();
  });

  test('a correct OTP enables MFA and issues stored recovery codes', async () => {
    withSecret();
    mockTotpValid = true;
    const res = await request(app()).post('/api/profile/mfa/verify').send({ code: '123456' });

    expect(res.status).toBe(200);
    expect(queries.find((q) => /mfa_enabled = TRUE/i.test(q.sql))).toBeTruthy();

    // Eight codes, and — the part that was missing — actually written down.
    expect(res.body.recoveryCodes).toHaveLength(8);
    const insert = queries.find((q) => /INSERT INTO mfa_recovery_codes/i.test(q.sql));
    expect(insert).toBeTruthy();

    // Digests, never the codes themselves.
    const stored = insert.params[1];
    for (const code of res.body.recoveryCodes) {
      expect(stored).not.toContain(code);
      expect(stored).toContain(recovery.hashCode(code));
    }
  });

  test('recovery codes are not written to the logs', async () => {
    withSecret();
    mockTotpValid = true;
    const res = await request(app()).post('/api/profile/mfa/verify').send({ code: '123456' });
    const logged = JSON.stringify(logLines);
    for (const code of res.body.recoveryCodes) expect(logged).not.toContain(code);
  });

  test('the TOTP secret is not echoed back on verification', async () => {
    // It was already shown once at setup; repeating it here would put it in
    // another response body and another client-side state for no reason.
    withSecret();
    mockTotpValid = true;
    const res = await request(app()).post('/api/profile/mfa/verify').send({ code: '123456' });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});

describe('DELETE /api/profile/mfa — turning it off', () => {
  test('clears the secret, the flag AND the stored recovery codes', async () => {
    const res = await request(app()).delete('/api/profile/mfa');

    expect(res.status).toBe(200);
    const upd = queries.find((q) => /UPDATE user_profiles/i.test(q.sql));
    expect(upd.sql).toMatch(/mfa_enabled = FALSE/i);
    expect(upd.sql).toMatch(/mfa_secret = NULL/i);

    // Leaving codes behind would keep an old printout working against a
    // secret that no longer exists.
    const del = queries.find((q) => /DELETE FROM mfa_recovery_codes/i.test(q.sql));
    expect(del).toBeTruthy();
    expect(del.params).toEqual([USER.id]);
  });
});

describe('the login validator accepts both second-factor shapes', () => {
  const { authSchemas } = require('../lib/validation');

  const parse = (mfa_code) => authSchemas.login.body.safeParse({
    email: 'sa@example.test', password: 'x', mfa_code,
  });

  test('accepts a 6-digit TOTP', () => {
    expect(parse('123456').success).toBe(true);
  });

  test('accepts a recovery code — this is what was rejected before', () => {
    // Verified against a running server pre-fix: the response was
    // {"fields":{"mfa_code":"MFA code must be 6 digits"}}, so the code never
    // reached the handler that could have redeemed it.
    for (const code of recovery.generateCodes(20)) {
      expect(parse(code).success).toBe(true);
    }
  });

  test('accepts a recovery code typed in lower case or without the hyphen', () => {
    const code = recovery.generateCodes(1)[0];
    expect(parse(code.toLowerCase()).success).toBe(true);
    expect(parse(code.replace('-', '')).success).toBe(true);
    expect(parse(code.replace('-', ' ')).success).toBe(true);
  });

  test('still rejects obvious rubbish', () => {
    expect(parse('12345').success).toBe(false);
    expect(parse('!!!!!!').success).toBe(false);
  });

  test('remains optional, so non-MFA logins are unaffected', () => {
    expect(authSchemas.login.body.safeParse({ email: 'a@b.test', password: 'x' }).success).toBe(true);
  });
});
