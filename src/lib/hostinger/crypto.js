'use strict';
// Encryption at rest for the Hostinger API token.
//
// ── Why this file exists at all ─────────────────────────────────────────────
//
// This codebase had no encryption-at-rest helper when this module was written:
// integrations.api_key is plaintext, google_calendar_tokens is plaintext, and
// migrations mention a FACE_ENCRYPTION_KEY that no JS code has ever read. So
// the Hostinger token could not "reuse the existing pattern" — there was none.
//
// The token being protected can stop, restart and recreate the production VPS
// and read every website's files. It is the highest-value secret the platform
// holds, and it is stored in a database that is dumped, replicated and read by
// tooling. Plaintext was not an option.
//
// ── Shape of the envelope ───────────────────────────────────────────────────
//
//   v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
//
// AES-256-GCM: authenticated, so a tampered row fails to decrypt instead of
// decrypting to something attacker-chosen. A random 12-byte IV per write is
// required for GCM — reusing one would leak the keystream — and it is stored
// beside the ciphertext rather than derived, because deriving from a per-row
// id would make a re-keyed row silently undecryptable.
//
// The version prefix is the whole reason rotation of the KEY is a future
// possibility: a new key can be written as `v2` while `v1` rows still decrypt,
// instead of requiring one-shot re-encryption of everything.
//
// ── What this file deliberately does NOT do ────────────────────────────────
//
// No key derivation, no salt storage, no passphrase support. The key is 32
// bytes of entropy from the environment, the way JWT_SECRET and every other
// secret in this deployment already arrives. Stretching a low-entropy human
// string here would create the appearance of rigour while the real requirement
// is a generated key in the secret store.

const crypto = require('crypto');

const KEY_ENV = 'HOSTINGER_TOKEN_KEY';
const VERSION = 'v1';

/**
 * Read the key, or explain precisely why it cannot be used.
 *
 * Returns null when the variable is unset — that is the "module not configured"
 * state, which the console renders as a connect prompt rather than crashing the
 * API. Returns a string when it IS set but unusable: that difference is what
 * lets server.js refuse to boot in production on a typo, because a malformed
 * key means stored rows silently become undecryptable, and a deployment that
 * boots but cannot decrypt its own credential is worse than one that refuses.
 */
function keyProblem() {
  const present = process.env[KEY_ENV];
  const raw = String(present || '').trim();
  // Set-but-blank is a problem, not "unset": a key of spaces reports as
  // configured and then dies on the first write with "Invalid key length".
  if (!raw) return present ? `${KEY_ENV} is set but empty` : null;

  const buf = decodeKey(raw);
  if (!buf) return `${KEY_ENV} is not valid base64 or hex`;
  if (buf.length !== 32) {
    return `${KEY_ENV} must decode to 32 bytes (got ${buf.length}) — generate one with: openssl rand -base64 32`;
  }
  return null;
}

/** 32 bytes from base64 or hex, or null. Both are accepted because both are what people paste. */
function decodeKey(raw) {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  // base64 / base64url
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 32) return buf;
  // A 64-char hex string also parses as valid base64 but yields 48 bytes; the
  // hex branch above already caught that case, so reaching here means malformed.
  return buf;
}

/** True when a usable key is present. The module's "configured" gate. */
function isConfigured() {
  return !!process.env[KEY_ENV] && keyProblem() === null;
}

function key() {
  const problem = keyProblem();
  if (problem) throw new Error(problem);
  if (!process.env[KEY_ENV]) throw new Error(`${KEY_ENV} is not set`);
  return decodeKey(String(process.env[KEY_ENV]).trim());
}

/**
 * Encrypt a token into a storable envelope.
 *
 * Never logs, never returns the plaintext, and refuses an empty value: storing
 * an encryption of '' would look connected and authenticate nothing.
 */
function encryptToken(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext.trim()) {
    throw new Error('refusing to encrypt an empty token');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

/**
 * Decrypt an envelope.
 *
 * Throws on: wrong shape, unknown version, tampered ciphertext or tag, wrong
 * key. Callers treat every one of those as "the stored credential is unusable"
 * and surface an actionable error; there is no partial-success path that
 * returns an empty string, because an empty token would be sent to Hostinger as
 * a bearer and read as an authentication failure rather than a storage fault.
 */
function decryptToken(envelope) {
  const parts = String(envelope || '').split('.');
  if (parts.length !== 4) throw new Error('credential envelope is malformed');
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) throw new Error(`unsupported credential envelope version: ${version}`);
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('credential envelope is malformed');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * What the console may display: last four characters, never more.
 *
 * Hostinger API tokens are long; four characters identify a row in hPanel
 * without being a usable credential, and this value is written to the DB, sent
 * to the browser and printed in logs, so the margin matters.
 */
function maskToken(token) {
  const s = String(token || '');
  return s.length <= 4 ? '••••' : `…${s.slice(-4)}`;
}

/**
 * A stable, non-reversible reference to a token: sha256, first 16 hex chars.
 *
 * Answers "is this the token already stored?" and "which token was replaced?"
 * without the value being recoverable. Truncated because 64 hex chars of a
 * secret's hash in an audit row is more fingerprint than anything needs.
 */
function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex').slice(0, 16);
}

module.exports = {
  KEY_ENV,
  VERSION,
  isConfigured,
  keyProblem,
  encryptToken,
  decryptToken,
  maskToken,
  fingerprint,
};
