// src/lib/faceEncryption.js
//
// AES-256-GCM encryption for face descriptors stored in the database.
//
// Usage:
//   const { encryptDescriptor, decryptDescriptor, isEncryptionEnabled } = require('./faceEncryption');
//
// Environment:
//   FACE_ENCRYPTION_KEY — 64 hex characters (32 bytes).
//   If absent, encryption is disabled and plaintext descriptors are used
//   (backwards-compatible with existing rows written before this feature).
//
// Wire format stored in face_descriptors.descriptor_enc:
//   base64( iv[12] || authTag[16] || ciphertext )
//   All three parts are concatenated into a single base64 string.

'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES   = 12;   // 96-bit IV recommended for GCM
const TAG_BYTES  = 16;   // 128-bit auth tag

function loadKey() {
  const hex = process.env.FACE_ENCRYPTION_KEY;
  if (!hex) return null;
  if (hex.length !== 64) {
    throw new Error(
      'FACE_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). ' +
      `Got ${hex.length} characters.`
    );
  }
  return Buffer.from(hex, 'hex');
}

// Cache key at module load time — fails fast on bad config.
let _key;
try {
  _key = loadKey();
} catch (err) {
  // Log but don't crash the process; the server will fail at first encrypt attempt.
  console.error('[faceEncryption] Key load error:', err.message);
  _key = null;
}

function isEncryptionEnabled() {
  return _key !== null;
}

/**
 * Encrypt a 128-float face descriptor array.
 * Returns a base64 string: iv || authTag || ciphertext.
 * Throws if FACE_ENCRYPTION_KEY is not set.
 */
function encryptDescriptor(descriptorArray) {
  if (!_key) {
    throw new Error('FACE_ENCRYPTION_KEY is not configured — cannot encrypt face descriptor');
  }
  const plaintext = JSON.stringify(descriptorArray);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, _key, iv);
  const enc1 = cipher.update(plaintext, 'utf8');
  const enc2 = cipher.final();
  const authTag = cipher.getAuthTag();
  // Pack: iv(12) + authTag(16) + ciphertext
  const packed = Buffer.concat([iv, authTag, enc1, enc2]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64-encoded encrypted descriptor back to a number[128] array.
 * Returns null if decryption fails (tampered data, wrong key, etc.) so the
 * caller can skip this record rather than crashing the entire recognition pass.
 */
function decryptDescriptor(b64) {
  if (!_key) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length <= IV_BYTES + TAG_BYTES) return null;
    const iv      = buf.subarray(0, IV_BYTES);
    const authTag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct      = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, _key, iv);
    decipher.setAuthTag(authTag);
    const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { encryptDescriptor, decryptDescriptor, isEncryptionEnabled };
