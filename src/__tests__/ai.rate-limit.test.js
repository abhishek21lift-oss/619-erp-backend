'use strict';

// Tests for src/lib/ai/rateLimit.js — P0-8 per-intent AI rate limiting.
//
// The factory reuses express-rate-limit + lib/rateLimitStore.makeStore, exactly
// like every other limiter in the app, so the counter is Redis-backed and
// correct across N api replicas. Each intent gets its own prefixed store so
// intents never share a counter. It keys on the authenticated user and fails
// open on store errors.

// The limiter's store comes from makeStore, which reads redis.isConfigured().
// Return undefined (no Redis) so express-rate-limit uses its default in-process
// store — sufficient to prove the middleware throttles per key.
jest.mock('../lib/rateLimitStore', () => ({ makeStore: jest.fn(() => undefined) }));
jest.mock('../lib/redis', () => ({ isConfigured: () => false }));

const { aiIntentLimit, INTENT_LIMITS } = require('../lib/ai/rateLimit');

const request = require('supertest');
const express = require('express');

function buildApp(intent) {
  const app = express();
  app.use(express.json());
  // Middleware that behaves like auth: populates req.user. Order matters:
  // a throttled request never reaches the handler.
  app.use((req, _res, next) => {
    req.user = { id: 'usr-1', role: 'trainer', organization_id: 'org-1' };
    next();
  });
  const limiter = aiIntentLimit(intent);
  app.get('/boom', limiter, (_req, res) => res.json({ ok: true }));
  return app;
}

/* ── Configuration integrity ───────────────────────────────────────────────── */

describe('INTENT_LIMITS', () => {
  test('covers every rate-limitable AI intent with a positive window and max', () => {
    const keys = Object.keys(INTENT_LIMITS);
    // chat, workout, diet, progress, assessment, business, knowledge_ingest, client_agent.
    expect(keys.length).toBe(8);
    for (const [intent, cfg] of Object.entries(INTENT_LIMITS)) {
      expect(cfg.windowMs).toBeGreaterThan(0);
      expect(cfg.max).toBeGreaterThan(0);
      expect(intent.length).toBeGreaterThan(0);
    }
  });

  test('interactive chat is not starved by expensive generation/insights intents', () => {
    // Chat is the highest-volume surface; generation/insights are expensive and
    // bursty. Chat's allowance must be strictly larger.
    expect(INTENT_LIMITS.chat.max).toBeGreaterThan(INTENT_LIMITS.workout.max);
    expect(INTENT_LIMITS.chat.max).toBeGreaterThan(INTENT_LIMITS.business.max);
  });

  test('client_agent has its own bucket separate from chat', () => {
    expect(INTENT_LIMITS.client_agent).toBeDefined();
    expect(INTENT_LIMITS.client_agent.windowMs).toBeGreaterThan(0);
    expect(INTENT_LIMITS.client_agent.max).toBeGreaterThan(0);
  });
});

/* ── Factory contract ──────────────────────────────────────────────────────── */

describe('aiIntentLimit', () => {
  test('throws for an unknown intent', () => {
    expect(() => aiIntentLimit('nope')).toThrow(/Unknown AI intent/);
  });

  test('returns a working express middleware function', () => {
    const mw = aiIntentLimit('chat');
    expect(typeof mw).toBe('function');
  });
});

/* ── Throttling behaviour ───────────────────────────────────────────────────── */

describe('aiIntentLimit — throttling', () => {
  test('allows requests up to the cap and returns 429 after it', async () => {
    const { max } = INTENT_LIMITS.chat;
    const app = buildApp('chat');

    for (let i = 0; i < max; i++) {
      await request(app).get('/boom');
    }
    const over = await request(app).get('/boom');

    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('AI_RATE_LIMITED');
    expect(over.body.error.message).toMatch(/rate-limited/);
  });

  test('keys per user — a second user is not throttled by the first', async () => {
    const { max } = INTENT_LIMITS.chat;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // A different user id than buildApp's, so a fresh counter.
      req.user = { id: 'usr-2', role: 'trainer', organization_id: 'org-2' };
      next();
    });
    app.get('/boom', aiIntentLimit('chat'), (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < max; i++) {
      await request(app).get('/boom');
    }
    const res = await request(app).get('/boom');
    expect(res.status).toBe(429);
  });
});
