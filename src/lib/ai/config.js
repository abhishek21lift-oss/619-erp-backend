'use strict';
// src/lib/ai/config.js
//
// One answer to "is the AI provider configured", because there were two and
// they disagreed.
//
// ── The disagreement ───────────────────────────────────────────────────────
//
// The code that actually calls the provider reads two variables:
//
//     lib/ai/openrouter.js:27   process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY
//     routes/ai.js:74           process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY
//
// The code that REPORTS whether it is configured reads one:
//
//     routes/ai.js:2079  (GET /api/ai/health)        process.env.OPENROUTER_API_KEY
//     routes/ai.js:2134  (GET /api/ai/provider-settings)  process.env.OPENROUTER_API_KEY
//
// So a box configured with AI_API_KEY — the first name the working code looks
// for — has fully functional AI while its own health endpoint reports
// `configured: false`, and the operator's integrations page says the provider
// is not set up. The console lies about the one thing it exists to report,
// and it lies in the direction that sends somebody hunting for a missing key
// that is present.
//
// The reverse is just as bad on a box mid-rotation: OPENROUTER_API_KEY left
// behind and AI_API_KEY removed reports `configured: true` while every
// generation fails.
//
// This is the same shape as lib/tenantRlsFlag.js — a predicate three files
// must agree on belongs in one file — and it is here for the same reason: the
// copies had already drifted.

/**
 * The provider key, or null.
 *
 * AI_API_KEY first, matching the order the calling code has always used.
 * .env.example documents OPENROUTER_API_KEY, so both are live in the wild and
 * neither can be dropped.
 */
function apiKey(env = process.env) {
  return env.AI_API_KEY || env.OPENROUTER_API_KEY || null;
}

/** Where requests go. Defaulted, so its absence is never the failure. */
function baseUrl(env = process.env) {
  return env.AI_BASE_URL || 'https://openrouter.ai/api/v1';
}

/** Can this process call the provider at all? */
function isConfigured(env = process.env) {
  return Boolean(apiKey(env));
}

/**
 * Why it is not configured, in words an operator can act on.
 *
 * Names both variables, because "the key is missing" is unhelpful when the
 * reason is that the key is present under the other name.
 */
function configurationProblem(env = process.env) {
  if (isConfigured(env)) return null;
  return 'Neither AI_API_KEY nor OPENROUTER_API_KEY is set. Either one configures '
    + 'the provider; AI_API_KEY takes precedence when both are present.';
}

/**
 * Which variable supplied the key.
 *
 * Reported so an operator can see WHICH of the two is in play without echoing
 * the key itself — the question during a rotation is "which name is live", and
 * answering it has never required revealing the value.
 */
function keySource(env = process.env) {
  if (env.AI_API_KEY) return 'AI_API_KEY';
  if (env.OPENROUTER_API_KEY) return 'OPENROUTER_API_KEY';
  return null;
}

module.exports = { apiKey, baseUrl, isConfigured, configurationProblem, keySource };
