'use strict';
// A cost control that cannot run must not be quiet about it.
//
// requireAiQuota() fails OPEN when its own check throws, deliberately: a
// quota lookup that errors must not take the AI Suite down. That bias is
// correct and these tests keep it.
//
// What they add is the other half. The guard used to emit one warn line per
// failed request — the same level as routine noise — so a degraded database
// meant every studio's spending cap silently stopped applying, for as long
// as the degradation lasted, with nothing an alert could match on. An hour
// of that is an hour of uncapped spend that looks exactly like a healthy
// hour in the logs.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const logger = require('../lib/logger');
const pool = require('../db/pool');
const { requireAiQuota, quotaEnforcementHealth } = require('../lib/aiQuota');

const guard = requireAiQuota();
const reqFor = (orgId = 'org-1') => ({ user: { organization_id: orgId, role: 'admin' } });
const resStub = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

async function runGuard() {
  const next = jest.fn();
  await guard(reqFor(), resStub(), next);
  return next;
}

// Drive the counter back to zero between tests via a successful check.
async function resetStreak() {
  pool.query.mockResolvedValue({ rows: [{ tokens: '0', requests: 0, value: null }] });
  await runGuard();
}

beforeEach(async () => {
  pool.query.mockReset();
  await resetStreak();
  logger.warn.mockClear();
  logger.error.mockClear();
  logger.info.mockClear();
});

describe('the guard still fails open', () => {
  it('lets the request through when the check throws', async () => {
    pool.query.mockRejectedValue(new Error('db down'));
    const next = await runGuard();
    expect(next).toHaveBeenCalled();
  });
});

describe('but it is no longer silent about it', () => {
  it('warns on the first failure, naming the effect', async () => {
    pool.query.mockRejectedValue(new Error('db down'));
    await runGuard();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        consecutive_failures: 1,
        effect: expect.stringMatching(/NOT being enforced/),
      }),
      'ai_quota_check_failed'
    );
  });

  it('escalates to error once the failures are a streak, not a blip', async () => {
    pool.query.mockRejectedValue(new Error('db down'));
    await runGuard();
    await runGuard();
    await runGuard();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ consecutive_failures: 3 }),
      'ai_quota_enforcement_degraded'
    );
  });

  it('exposes the blindness as state, not only as a log line', async () => {
    pool.query.mockRejectedValue(new Error('db down'));
    await runGuard();
    await runGuard();
    await runGuard();

    const health = quotaEnforcementHealth();
    expect(health.degraded).toBe(true);
    expect(health.consecutive_failures).toBe(3);
    expect(health.since).toEqual(expect.any(String));
  });

  it('reports recovery, so the streak has a visible end', async () => {
    pool.query.mockRejectedValue(new Error('db down'));
    await runGuard();
    await runGuard();

    pool.query.mockResolvedValue({ rows: [{ tokens: '0', requests: 0, value: null }] });
    await runGuard();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ recovered_after: 2 }),
      'ai_quota_check_recovered'
    );
    expect(quotaEnforcementHealth().degraded).toBe(false);
  });

  it('a healthy check leaves no degraded state behind', async () => {
    pool.query.mockResolvedValue({ rows: [{ tokens: '0', requests: 0, value: null }] });
    await runGuard();
    expect(quotaEnforcementHealth()).toMatchObject({ consecutive_failures: 0, degraded: false });
  });
});
