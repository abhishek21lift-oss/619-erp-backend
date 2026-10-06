'use strict';
// src/lib/secretScrub.js
//
// A defensive scrub for free text that is about to leave the process — into a
// browser, a database row, or an audit record.
//
// lib/logger.js redacts by PATH: authorization headers, passwords, emails,
// mobiles. That covers structured fields. It does not cover a secret that
// arrives inside a free-text message or an error string — and those are
// exactly what an upstream provider hands back when something goes wrong
// ("invalid key sk-or-v1-…", "Bearer … rejected"). This is the backstop for
// that case.
//
// Lived inside modules/command-center/logCapture.js until the AI gateway
// probe needed the same thing. lib/ must not reach up into modules/, so it
// moved down here and logCapture re-exports it; there is still exactly one
// list of patterns.
//
// Deliberately conservative. Over-masking an error string costs an operator
// one ssh; under-masking puts a live credential in a table and a browser tab.

const SCRUBBERS = [
  // postgres://user:pass@host  →  postgres://user:[REDACTED]@host
  [/\b([a-z+]+:\/\/[^:\s/@]+):[^@\s]+@/gi, '$1:[REDACTED]@'],
  // Bearer tokens and JWTs. The JWT-shaped bearer first, so the generic
  // bearer rule below does not have to know about dots.
  [/\bBearer\s+[\w-]+\.[\w-]+\.[\w-]+/gi, 'Bearer [REDACTED]'],
  [/\beyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g, '[REDACTED_JWT]'],
  // Any other bearer credential: opaque provider keys are not JWTs.
  [/\bBearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  // Provider keys that announce themselves by prefix.
  [/\b(sk|rk|re|whsec)_[A-Za-z0-9]{12,}/g, '$1_[REDACTED]'],
  // OpenAI / OpenRouter / Anthropic style: sk-…, sk-or-v1-…, sk-ant-…
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza[REDACTED]'],
  // NVIDIA, Groq, Cerebras, xAI, Hugging Face and similar prefixed keys.
  [/\b(nvapi|gsk|csk|xai|hf)[-_][A-Za-z0-9_-]{16,}/g, '$1-[REDACTED]'],
  // Credentials carried in a query string.
  [/([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"']+/gi, '$1[REDACTED]'],
];

/** Mask anything credential-shaped in a string. Non-strings pass through. */
function scrub(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, replacement] of SCRUBBERS) out = out.replace(re, replacement);
  return out;
}

/**
 * Scrub, then also mask any literal value the caller knows is secret, then
 * bound the length.
 *
 * The literal pass is what the pattern list cannot do: a key with no
 * recognisable prefix is invisible to every regex above, but the process
 * holding it knows exactly what it looks like. Values shorter than 8
 * characters are skipped — masking every "abc" in a message protects nothing
 * and destroys the message.
 *
 * @param {unknown} text
 * @param {{ secrets?: Array<string|null|undefined>, max?: number }} [opts]
 * @returns {string|null}
 */
function scrubBounded(text, { secrets = [], max = 240 } = {}) {
  if (text === null || text === undefined) return null;
  let out = scrub(String(text));
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8) out = out.split(s).join('[REDACTED]');
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

module.exports = { scrub, scrubBounded, SCRUBBERS };
