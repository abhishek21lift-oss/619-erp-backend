'use strict';
// Per-user limit on AI calls (AI audit 2026-09-28, AI-3).
//
// Every AI request is a paid, slow upstream call, and the only limit on them
// was the general API limiter — which, mounted ahead of `auth`, skips every
// request it cannot yet attribute to a user, i.e. all of them. This one is
// mounted AFTER authentication, keyed on the user, and counts only requests
// that start a model call (GETs — conversation lists, usage, health — are
// free, with one exception: knowledge search embeds the query on every call,
// so it is the one expensive GET this limiter counts). Twenty a minute is well above a trainer working normally and well
// below a loop.

const rateLimit = require('express-rate-limit');
const { makeStore } = require('../lib/rateLimitStore');

const AI_REQUESTS_PER_MINUTE = Number(process.env.AI_RATE_LIMIT_PER_MINUTE) > 0
  ? Number(process.env.AI_RATE_LIMIT_PER_MINUTE)
  : 20;

const aiLimiter = rateLimit({
  store: makeStore('ai'),
  passOnStoreError: true,
  windowMs: 60 * 1000,
  max: AI_REQUESTS_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip,
  // GETs are skipped as free — except knowledge search, which embeds the
  // query on every call and is the one expensive GET behind this limiter.
  skip: (req) =>
    (req.method === 'GET' || req.method === 'HEAD') &&
    !(req.baseUrl === '/api/ai/knowledge' && req.path === '/search'),
  message: {
    error: {
      code: 'AI_RATE_LIMITED',
      message: 'Too many AI requests in a minute — wait a moment and try again.',
    },
  },
});

module.exports = { aiLimiter, AI_REQUESTS_PER_MINUTE };
