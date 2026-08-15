'use strict';
// MFA recovery codes — issue, normalise, redeem.
//
// These existed in name only. POST /profile/mfa/verify minted eight random
// hex strings, returned them, and stored nothing; login validated mfa_code
// as /^\d{6}$/, so a recovery code was rejected as malformed before any
// lookup could happen. Both were verified against a running server before
// this was written: a recovery code came back
// `{"error":{"code":"VALIDATION","message":"Invalid request",
//   "fields":{"mfa_code":"MFA code must be 6 digits"}}}`.
//
// Meanwhile the Settings dialog told the user, in as many words, "each code
// can be used once to get back into your account if you lose access to your
// authenticator app." For the platform super admin — the only account that
// reaches the operator console, and the one SUPER_ADMIN_REQUIRE_MFA makes
// mandatory — that is the difference between a lost phone and a lost
// platform.
//
// The db here is a fake with the same surface pool exposes, so these run
// with no database and no network: what is being pinned is the format
// agreement and the single-use rule, both of which are pure logic.

const recovery = require('../lib/mfaRecoveryCodes');

/** Minimal stand-in for pg's pool: records calls, answers rowCount. */
function fakeDb(handlers = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const clean = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: clean, params });
      for (const [pattern, fn] of Object.entries(handlers)) {
        if (new RegExp(pattern, 'i').test(clean)) return fn(params);
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('code generation', () => {
  test('issues eight codes by default', () => {
    expect(recovery.generateCodes()).toHaveLength(8);
  });

  test('codes are grouped 5-5, which is how they are displayed and typed back', () => {
    for (const code of recovery.generateCodes()) {
      expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    }
  });

  test('uses the Crockford alphabet, so nothing reads as I, L, O or U', () => {
    // The whole point of the alphabet: these are transcribed off paper by
    // somebody who has just lost their phone, and 1/I and 0/O are the two
    // mistakes that actually happen.
    const all = recovery.generateCodes(200).join('');
    expect(all).not.toMatch(/[ILOU]/);
  });

  test('codes are not predictable — 200 codes, no repeats', () => {
    const codes = recovery.generateCodes(200);
    expect(new Set(codes).size).toBe(200);
  });
});

describe('normalisation', () => {
  test.each([
    ['M5FQA-KHD5F', 'M5FQA-KHD5F'],
    ['m5fqa-khd5f', 'lower case'],
    ['M5FQA KHD5F', 'a space instead of the hyphen'],
    ['M5FQAKHD5F', 'no separator at all'],
    ['  M5FQA-KHD5F  ', 'surrounding whitespace'],
  ])('%s is accepted (%s)', (input) => {
    expect(recovery.normalise(input)).toBe('M5FQAKHD5F');
  });

  test('maps the characters people misread: I and L to 1, O to 0', () => {
    // The alphabet never emits these, so anything arriving as I/L/O is a
    // transcription slip and should resolve rather than fail.
    expect(recovery.normalise('I5FQA-KHD5F')).toBe('15FQAKHD5F');
    expect(recovery.normalise('L5FQA-KHD5F')).toBe('15FQAKHD5F');
    expect(recovery.normalise('O5FQA-KHD5F')).toBe('05FQAKHD5F');
  });

  test('the same code in any accepted form hashes identically', () => {
    const canonical = recovery.hashCode('M5FQA-KHD5F');
    for (const variant of ['m5fqa-khd5f', 'M5FQA KHD5F', 'M5FQAKHD5F', ' M5FQA-KHD5F ']) {
      expect(recovery.hashCode(variant)).toBe(canonical);
    }
  });
});

describe('looksLikeRecoveryCode — what login uses to route the input', () => {
  test('accepts a real code', () => {
    expect(recovery.looksLikeRecoveryCode(recovery.generateCodes(1)[0])).toBe(true);
  });

  test('rejects a 6-digit TOTP, so the two paths never collide', () => {
    expect(recovery.looksLikeRecoveryCode('123456')).toBe(false);
  });

  test.each([['', 'empty'], [null, 'null'], ['ABC', 'too short'], ['M5FQA-KHD5FEXTRA', 'too long']])(
    'rejects %s (%s)', (input) => {
      expect(recovery.looksLikeRecoveryCode(input)).toBe(false);
    }
  );
});

describe('hashing', () => {
  test('is a sha256 hex digest, not the code itself', () => {
    const hash = recovery.hashCode('M5FQA-KHD5F');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('M5FQA');
  });

  test('different codes hash differently', () => {
    expect(recovery.hashCode('M5FQA-KHD5F')).not.toBe(recovery.hashCode('M5FQA-KHD5G'));
  });
});

describe('issueForUser', () => {
  test('replaces any previous set before inserting, and stores only digests', async () => {
    const db = fakeDb();
    const codes = await recovery.issueForUser(db, 'usr-1');

    expect(codes).toHaveLength(8);

    // Old codes go first: re-enrolling is exactly when a previous set stops
    // being trustworthy.
    expect(db.calls[0].sql).toMatch(/DELETE FROM mfa_recovery_codes WHERE user_id = \$1/i);
    expect(db.calls[0].params).toEqual(['usr-1']);

    const insert = db.calls[1];
    expect(insert.sql).toMatch(/INSERT INTO mfa_recovery_codes/i);
    const stored = insert.params[1];
    expect(stored).toHaveLength(8);

    // Nothing recognisable as the plaintext reaches the database.
    for (const hash of stored) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    for (const code of codes) {
      expect(stored).not.toContain(code);
      expect(stored).toContain(recovery.hashCode(code));
    }
  });
});

describe('redeem', () => {
  test('spends a valid unused code', async () => {
    const db = fakeDb({ 'UPDATE mfa_recovery_codes': () => ({ rowCount: 1 }) });
    await expect(recovery.redeem(db, 'usr-1', 'M5FQA-KHD5F')).resolves.toBe(true);
  });

  test('the UPDATE is the check — used_at IS NULL is in the WHERE, not a prior SELECT', async () => {
    // A SELECT-then-UPDATE would let two concurrent logins both spend the
    // same code. On the one credential that exists because something has
    // already gone wrong, that race is not acceptable.
    const db = fakeDb({ 'UPDATE mfa_recovery_codes': () => ({ rowCount: 1 }) });
    await recovery.redeem(db, 'usr-1', 'M5FQA-KHD5F');

    const q = db.calls[0];
    expect(q.sql).toMatch(/UPDATE mfa_recovery_codes SET used_at = NOW\(\)/i);
    expect(q.sql).toMatch(/used_at IS NULL/i);
    expect(q.sql).toMatch(/user_id = \$1/);
    expect(q.sql).toMatch(/code_hash = \$2/);
    expect(db.calls).toHaveLength(1);
  });

  test('an already-used code matches no row and is refused', async () => {
    const db = fakeDb({ 'UPDATE mfa_recovery_codes': () => ({ rowCount: 0 }) });
    await expect(recovery.redeem(db, 'usr-1', 'M5FQA-KHD5F')).resolves.toBe(false);
  });

  test('scopes to the user, so one account cannot spend another account\'s code', async () => {
    const db = fakeDb({ 'UPDATE mfa_recovery_codes': () => ({ rowCount: 1 }) });
    await recovery.redeem(db, 'usr-attacker', 'M5FQA-KHD5F');
    expect(db.calls[0].params[0]).toBe('usr-attacker');
  });

  test('never sends the plaintext to the database', async () => {
    const db = fakeDb({ 'UPDATE mfa_recovery_codes': () => ({ rowCount: 1 }) });
    await recovery.redeem(db, 'usr-1', 'M5FQA-KHD5F');
    expect(db.calls[0].params).not.toContain('M5FQA-KHD5F');
    expect(db.calls[0].params[1]).toBe(recovery.hashCode('M5FQA-KHD5F'));
  });

  test('a malformed code is refused without touching the database at all', async () => {
    const db = fakeDb();
    await expect(recovery.redeem(db, 'usr-1', '123456')).resolves.toBe(false);
    await expect(recovery.redeem(db, 'usr-1', '')).resolves.toBe(false);
    expect(db.calls).toHaveLength(0);
  });
});

describe('remainingForUser', () => {
  test('counts only unused codes', async () => {
    const db = fakeDb({ 'SELECT count': () => ({ rows: [{ n: 6 }] }) });
    await expect(recovery.remainingForUser(db, 'usr-1')).resolves.toBe(6);
    expect(db.calls[0].sql).toMatch(/used_at IS NULL/i);
  });

  test('answers 0 rather than throwing when the user has none', async () => {
    const db = fakeDb({ 'SELECT count': () => ({ rows: [] }) });
    await expect(recovery.remainingForUser(db, 'usr-1')).resolves.toBe(0);
  });
});
