'use strict';
// The credential's envelope.
//
// The token behind this file can recreate the production VPS, and the column
// it lives in is dumped, replicated and read by tooling. So the assertions are
// about what an attacker with the DATABASE gets: ciphertext that does not
// decrypt, a tampered row that throws instead of returning attacker-chosen
// bytes, and a hint that is four characters long.

const crypto = require('crypto');
const hc = require('../lib/hostinger/crypto');

const TOKEN = 'hst_live_example_token_0123456789abcdefghijklmnopqrstuvwxyz';

const B64_32 = crypto.randomBytes(32).toString('base64');
const HEX_64 = crypto.randomBytes(32).toString('hex');

let logSpy;

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  delete process.env.HOSTINGER_TOKEN_KEY;
});

describe('HOSTINGER_TOKEN_KEY', () => {
  it('is optional: unset means the module is inert, not broken', () => {
    delete process.env.HOSTINGER_TOKEN_KEY;
    expect(hc.keyProblem()).toBeNull();
    expect(hc.isConfigured()).toBe(false);
    expect(() => hc.encryptToken(TOKEN)).toThrow(/HOSTINGER_TOKEN_KEY is not set/);
  });

  it('accepts 32 bytes as base64 and as 64 hex characters', () => {
    for (const key of [B64_32, HEX_64, crypto.randomBytes(32).toString('base64url')]) {
      process.env.HOSTINGER_TOKEN_KEY = key;
      expect(hc.keyProblem()).toBeNull();
      expect(hc.isConfigured()).toBe(true);
      expect(hc.decryptToken(hc.encryptToken(TOKEN))).toBe(TOKEN);
    }
  });

  it('names the problem when the key is set but unusable', () => {
    for (const [key, expected] of [
      ['not-a-key', /must decode to 32 bytes \(got 6\)/],
      ['short', /must decode to 32 bytes/],
      [crypto.randomBytes(16).toString('base64'), /got 16/],
      ['zzzz zzzz', /base64 or hex/],
      // Whitespace-only used to read as "unset" and then die on first write.
      ['   ', /set but empty/],
    ]) {
      process.env.HOSTINGER_TOKEN_KEY = key;
      const problem = hc.keyProblem();
      expect(problem).toMatch(expected);
      expect(hc.isConfigured()).toBe(false);
      // A malformed key is a REFUSAL, not a silent fallback to a default key.
      expect(() => hc.encryptToken(TOKEN)).toThrow();
    }
  });
});

describe('envelope', () => {
  beforeEach(() => {
    process.env.HOSTINGER_TOKEN_KEY = B64_32;
  });

  it('round-trips a token', () => {
    expect(hc.decryptToken(hc.encryptToken(TOKEN))).toBe(TOKEN);
  });

  it('never stores the plaintext or its parts', () => {
    const envelope = hc.encryptToken(TOKEN);
    expect(envelope).not.toContain(TOKEN);
    expect(envelope).not.toContain(TOKEN.slice(0, 12));
    expect(envelope.startsWith('v1.')).toBe(true);
    expect(envelope.split('.')).toHaveLength(4);
  });

  it('uses a fresh IV per write, so the same token never writes the same row twice', () => {
    const a = hc.encryptToken(TOKEN);
    const b = hc.encryptToken(TOKEN);
    expect(a).not.toEqual(b);
    expect(a.split('.')[1]).not.toEqual(b.split('.')[1]);
    expect(hc.decryptToken(a)).toBe(TOKEN);
    expect(hc.decryptToken(b)).toBe(TOKEN);
  });

  it('refuses to encrypt an empty or non-string token', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      expect(() => hc.encryptToken(bad)).toThrow(/empty token/);
    }
  });

  it('throws on a tampered ciphertext rather than returning chosen bytes', () => {
    const parts = hc.encryptToken(TOKEN).split('.');
    const flipped = Buffer.from(parts[3], 'base64');
    flipped[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], flipped.toString('base64')].join('.');
    expect(() => hc.decryptToken(tampered)).toThrow();
  });

  it('throws on a tampered authentication tag', () => {
    const parts = hc.encryptToken(TOKEN).split('.');
    const tag = Buffer.from(parts[2], 'base64');
    tag[0] ^= 0xff;
    expect(() => hc.decryptToken([parts[0], parts[1], tag.toString('base64'), parts[3]].join('.'))).toThrow();
  });

  it('throws on an unknown version prefix', () => {
    const parts = hc.encryptToken(TOKEN).split('.');
    expect(() => hc.decryptToken(['v2', ...parts.slice(1)].join('.'))).toThrow(/unsupported credential envelope version/);
  });

  it('throws on a malformed envelope instead of returning an empty string', () => {
    // An empty token would be sent to Hostinger as a bearer and read as an
    // authentication failure rather than a storage fault.
    for (const bad of ['', 'v1', 'v1.a.b', null, undefined, {}, 'v1.!!!.!!!.!!!']) {
      expect(() => hc.decryptToken(bad)).toThrow();
    }
  });

  it('fails to decrypt when the key changes', () => {
    const envelope = hc.encryptToken(TOKEN);
    process.env.HOSTINGER_TOKEN_KEY = crypto.randomBytes(32).toString('base64');
    expect(() => hc.decryptToken(envelope)).toThrow();
  });
});

describe('display values', () => {
  it('shows the last four characters and nothing more', () => {
    expect(hc.maskToken(TOKEN)).toBe(`…${TOKEN.slice(-4)}`);
    expect(hc.maskToken(TOKEN).length).toBeLessThan(8);
    expect(hc.maskToken('abc')).toBe('••••');
    expect(hc.maskToken('')).toBe('••••');
    expect(hc.maskToken(undefined)).toBe('••••');
  });

  it('fingerprints stably, without the value being recoverable', () => {
    const fp = hc.fingerprint(TOKEN);
    expect(fp).toBe(hc.fingerprint(TOKEN));
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toBe(hc.fingerprint(`${TOKEN}x`));
    expect(fp).not.toContain(TOKEN.slice(0, 8));
  });
});
