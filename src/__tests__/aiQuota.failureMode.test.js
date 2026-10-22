// Bounded fail-open / fail-closed behaviour for the AI quota guard.
'use strict';

const express = require('express');
const request = require('supertest');
const logger = require('../lib/logger');

// Mock the DB pool BEFORE requiring the module under test.
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ query: mockQuery }));

jest.mock('../lib/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const aiQuota = require('../lib/aiQuota');

/**
 * Build an Express app that mounts the quota guard and a terminal 200 handler.
 * The guard is mounted at /ai/*, which is where AI routes live in practice.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  // Middleware to simulate authenticated user from header (for test purposes)
  app.use((req, res, next) => {
    const orgId = req.headers['x-org-id'];
    if (orgId) {
      req.user = { organization_id: orgId, role: 'trainer' };
    }
    next();
  });
  app.use('/ai', aiQuota.requireAiQuota());
  app.get('/ai/test', (req, res) => res.status(200).json({ ok: true }));
  return app;
}

/**
 * Helper to execute a request against the app with a studio user.
 */
async function get(app, orgId = 'org-1') {
  return request(app).get('/ai/test').set('X-Org-Id', orgId);
}

/**
 * Mock the three queries the guard performs (settings, limits, usage)
 * so they all reject — simulating a quota store that is completely unavailable.
 */
function mockQuotaStoreFails(errMsg = 'connection refused') {
  mockQuery.mockRejectedValue(new Error(errMsg));
}

/**
 * Mock a healthy quota store that returns enforcement DISABLED (so the
 * request passes through with 200 and the streak resets).
 */
function mockQuotaStoreHealthy() {
  mockQuery.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/FROM ai_platform_settings/.test(s)) return { rows: [{ enforcement_enabled: false, default_monthly_tokens: 1000, warn_at_pct: 80 }] };
    if (/FROM organization_ai_limits/.test(s)) return { rows: [] };
    if (/FROM ai_usage_log/.test(s)) return { rows: [{ tokens: '0', requests: '0' }] };
    return { rows: [] };
  });
}

function resetEnvAndModule() {
  // Clear any env var we might have set.
  delete process.env.AI_QUOTA_FAILURE_MODE;
  // Reset the module's internal streak state.
  aiQuota.resetQuotaFailureState();
  // Reset mocks.
  mockQuery.mockReset();
  logger.warn.mockReset();
  logger.info.mockReset();
  logger.error.mockReset();
}

describe('AI quota failure mode (bounded fail-open)', () => {
  let app;

  beforeEach(() => {
    resetEnvAndModule();
    app = buildApp();
  });

  afterAll(() => {
    resetEnvAndModule();
  });

  describe('default mode (unset AI_QUOTA_FAILURE_MODE)', () => {
    it('requests 1 and 2 pass (200) while streak < FAILURE_STREAK_ALERT', async () => {
      mockQuotaStoreFails();

      // Request 1
      const r1 = await get(app);
      expect(r1.status).toBe(200);
      expect(r1.body).toEqual({ ok: true });

      // Request 2
      const r2 = await get(app);
      expect(r2.status).toBe(200);
      expect(r2.body).toEqual({ ok: true });

      // Streak is now 2 (below default threshold of 3)
      expect(aiQuota.quotaEnforcementHealth().consecutive_failures).toBe(2);
      expect(aiQuota.quotaEnforcementHealth().degraded).toBe(false);
    });

    it('request 3 returns 503 with code AI_QUOTA_UNVERIFIABLE once streak reaches threshold', async () => {
      mockQuotaStoreFails();

      // Request 1
      await get(app);
      // Request 2
      await get(app);
      // Request 3 — should be refused
      const r3 = await get(app);
      expect(r3.status).toBe(503);
      expect(r3.body.error.code).toBe('AI_QUOTA_UNVERIFIABLE');

      // Streak is now 3 (at threshold)
      expect(aiQuota.quotaEnforcementHealth().consecutive_failures).toBe(3);
      expect(aiQuota.quotaEnforcementHealth().degraded).toBe(true);
    });

    it('resetQuotaFailureState clears the streak between test cases', async () => {
      mockQuotaStoreFails();
      await get(app); // 1
      await get(app); // 2
      expect(aiQuota.quotaEnforcementHealth().consecutive_failures).toBe(2);

      aiQuota.resetQuotaFailureState();

      expect(aiQuota.quotaEnforcementHealth().consecutive_failures).toBe(0);
      expect(aiQuota.quotaEnforcementHealth().degraded).toBe(false);
    });
  });

  describe('AI_QUOTA_FAILURE_MODE=fail-open', () => {
    it('even after 5 failures, requests return 200', async () => {
      process.env.AI_QUOTA_FAILURE_MODE = 'fail-open';
      // Need to re-require or the module will have cached the old env value.
      // But quotaFailClosed reads process.env each call, so no re-require needed.
      mockQuotaStoreFails();

      for (let i = 0; i < 5; i++) {
        const r = await get(app);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true });
      }

      // Streak still increments internally, but quotaFailClosed returns false
      expect(aiQuota.quotaEnforcementHealth().consecutive_failures).toBe(5);
      expect(aiQuota.quotaFailClosed()).toBe(false);
    });
  });

  describe('AI_QUOTA_FAILURE_MODE=fail-closed', () => {
    it('first failure returns 503 with code AI_QUOTA_UNVERIFIABLE', async () => {
      process.env.AI_QUOTA_FAILURE_MODE = 'fail-closed';
      mockQuotaStoreFails();

      const r = await get(app);
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('AI_QUOTA_UNVERIFIABLE');

      expect(aiQuota.quotaFailClosed()).toBe(true);
    });
  });

  describe('recovery', () => {
    it('after reset and a successful pool response returning enforcement disabled, 200 and consecutive_failures === 0', async () => {
      // First, accumulate some failures
      mockQuotaStoreFails();
      await get(app);
      await get(app);
      expect(aiQuota.quotaEnforcementHealth().consecutive_failures).toBe(2);

      // Reset the streak
      aiQuota.resetQuotaFailureState();
      expect(aiQuota.quotaEnforcementHealth().consecutive_failures).toBe(0);

      // Now mock a healthy response (enforcement disabled so request passes)
      mockQuotaStoreHealthy();
      const r = await get(app);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });

      // The successful check should have reset the streak to 0
      expect(aiQuota.quotaEnforcementHealth().consecutive_failures).toBe(0);
      expect(aiQuota.quotaEnforcementHealth().degraded).toBe(false);
    });
  });
});