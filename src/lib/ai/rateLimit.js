'use strict';

// src/lib/ai/rateLimit.js — Per-intent AI rate limiting (P0-8).
//
// The generic per-user limiter in server.js (userApiLimiter, 200 req/min)
// guards the whole /api/ai surface with ONE bucket. That is coarse: a studio
// hammering /chat could consume the budget that /business/insights needs, and
// a burst of knowledge-ingestion uploads would throttle interactive coaching.
// This module shares out that budget per INTENT so each kind of AI work gets
// its own allowance and one endpoint's traffic cannot starve another's.
//
// It reuses the two primitives the rest of the app already uses —
// express-rate-limit and lib/rateLimitStore.makeStore — so the counter is
// backed by the SAME Redis store as every other limiter (correct across N api
// replicas) and separately prefixed per intent (so intents never share a
// counter, and none of them collide with the login/invite/user limiters).
//
// It applies only AFTER auth (the limiter keys on req.user.id), so a shared
// office connection or a busy NAT gateway does not collapse several studios
// into one counter. Unauthenticated requests fall through to this app's
// existing IP-based apiLimiter instead.
//
// Deliberately fail-open: like every limiter in this codebase, the store
// errors are passed through so a Redis blip never 500s the AI suite — rate
// limiting is a cost/abuse control, not an authorization boundary.

const rateLimit = require('express-rate-limit');
const { makeStore } = require('../rateLimitStore');

// Per-intent allowance. Values are chosen to protect the cheapest, most
// interactive surface (chat/coaching) from being starved by the expensive,
// bursty ones (diet/workout generation, business reporting, knowledge
// ingestion). 1 minute windows keep limits user-friendly while still
// catching runaway loops. Tuned to be generous for a single studio while
// unmistakably bounding abuse; enforcement is on by default for these
// because unlike aiQuota (cost control) these are abuse controls.
//
// NOTE: intent keys here must match the intent the route passes to
// routedChat/routedStream (src/lib/ai/models.js INTENT_ROUTES) so a report
// about "rate limited" is understood in the same vocabulary as the model
// routing tables. Only intents tied to a real route are listed — a bucket for
// an intent no route emits is dead config. (Tool-calling "client-agent" work
// runs INSIDE /chat today, so it is throttled by the chat bucket; there is no
// separate client_agent route.)
const INTENT_LIMITS = {
  chat:             { windowMs: 60 * 1000, max: 60 },   // conversational coaching (also carries tool-calling)
  workout:          { windowMs: 60 * 1000, max: 8 },    // expensive JSON schema generation
  diet:             { windowMs: 60 * 1000, max: 8 },    // expensive JSON schema generation
  progress:         { windowMs: 60 * 1000, max: 12 },   // analysis
  assessment:       { windowMs: 60 * 1000, max: 12 },   // fitness-testing analysis
  business:         { windowMs: 60 * 1000, max: 6 },    // cross-studio reporting
  knowledge_ingest: { windowMs: 60 * 1000, max: 20 },   // document upload / ingestion (POST / and /:id/reindex)
  client_agent:     { windowMs: 60 * 1000, max: 30 },   // mps-ai client-facing agent (proxied through ERP governance)
};

function overLimitMessage(limit, windowMs) {
  const windowMinutes = Math.round(windowMs / 60000);
  return {
    error: {
      code: 'AI_RATE_LIMITED',
      message: `This type of AI request is rate-limited to ${limit} per ${windowMinutes} minute(s). Please wait and try again.`,
      limit,
      window_minutes: windowMinutes,
    },
  };
}

/**
 * Build an express-rate-limit middleware for a single AI intent.
 *
 * The returned middleware should be mounted directly on the route handler for
 * that intent, AFTER `auth`/`requireConfigured` and BEFORE anything that
 * streams or calls the model, so a throttled request never reaches RAG, tools,
 * or the model and never opens an SSE stream.
 *
 * @param {string} intent One of INTENT_LIMITS (e.g. 'chat', 'workout').
 * @returns {object} express-rate-limit middleware.
 */
function aiIntentLimit(intent) {
  const cfg = INTENT_LIMITS[intent];
  if (!cfg) {
    throw new Error(`Unknown AI intent "${intent}" — add it to INTENT_LIMITS in lib/ai/rateLimit.js`);
  }
  return rateLimit({
    store: makeStore(`ai:${intent}`),
    passOnStoreError: true,
    windowMs: cfg.windowMs,
    max: cfg.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ?? req.ip,
    skip: (req) => !req.user,
    message: overLimitMessage(cfg.max, cfg.windowMs),
  });
}

module.exports = { aiIntentLimit, INTENT_LIMITS };
