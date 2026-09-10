'use strict';
// Recovering a queued message whose BullMQ job never made it.
//
// ── What this file proves and what it cannot ────────────────────────────────
//
// The repository is mocked here, so these are assertions about CONTROL FLOW:
// that Redis is asked whether the job exists before anything is enqueued, that
// the job id is the same deterministic one the engine would have used, that a
// studio with automation off is not swept, that one studio's failure does not
// end the run.
//
// Which ROWS are candidates is a property of a WHERE clause and is proved in
// automation.concurrency.integration.test.js against real PostgreSQL — a mock
// returns what the fixture said regardless of the predicate.

jest.mock('../modules/automation/automation.repository', () => ({
  orgsWithAutomationOn: jest.fn(),
  orphanCandidates: jest.fn(),
}));

const mockEnsureReady = jest.fn();
jest.mock('../lib/redis', () => ({ ensureReady: (...a) => mockEnsureReady(...a) }));

const mockGetJob = jest.fn();
jest.mock('../jobs/queue', () => ({
  whatsappQueue: { getJob: (...a) => mockGetJob(...a) },
}));

const mockEnqueue = jest.fn();
jest.mock('../services/whatsapp.service', () => ({
  enqueueWhatsapp: (...a) => mockEnqueue(...a),
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const repo = require('../modules/automation/automation.repository');
const recovery = require('../modules/automation/automation.recovery');

const ORG_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTOMATION_RECOVERY_GRACE_SEC;
  delete process.env.AUTOMATION_RECOVERY_MAX_AGE_SEC;
  delete process.env.WA_SEND_DEDUPE_TTL_SEC;

  repo.orgsWithAutomationOn.mockResolvedValue([]);
  repo.orphanCandidates.mockResolvedValue([]);
  mockEnsureReady.mockResolvedValue(true);
  mockGetJob.mockResolvedValue(null);
  mockEnqueue.mockResolvedValue({ id: 'wa-auto-log-1' });
});

describe('what counts as orphaned', () => {
  test('Redis is asked whether the job exists before anything is enqueued', async () => {
    // The whole difference between an orphan and a message that is simply
    // waiting. A three-day reminder mid-delay is queued, old, and perfectly
    // healthy — only Redis can tell them apart.
    repo.orphanCandidates.mockResolvedValue([{ id: 'log-1', remainingDelayMs: 0 }]);
    mockGetJob.mockResolvedValue({ id: 'wa-auto-log-1' });

    const stats = await recovery.recoverOrg(ORG_A);

    expect(mockGetJob).toHaveBeenCalledWith('wa-auto-log-1');
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ candidates: 1, requeued: 0, jobPresent: 1 });
  });

  test('a missing job is re-enqueued under the SAME deterministic id', async () => {
    // `wa-auto-<logId>` is what the engine used. Reusing it is what makes a
    // second sweep — or two replicas sweeping at once — produce one job rather
    // than two: BullMQ refuses a duplicate id while the job exists.
    repo.orphanCandidates.mockResolvedValue([{ id: 'log-7', remainingDelayMs: 0 }]);

    const stats = await recovery.recoverOrg(ORG_A);

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [type, data, opts] = mockEnqueue.mock.calls[0];
    expect(type).toBe('automation');
    expect(data).toMatchObject({ logId: 'log-7', orgId: ORG_A });
    expect(opts.jobId).toBe('wa-auto-log-7');
    expect(stats).toMatchObject({ requeued: 1, jobPresent: 0 });
  });

  test('the job carries the studio it acts for, never a default', async () => {
    repo.orphanCandidates.mockResolvedValue([{ id: 'log-8', remainingDelayMs: 0 }]);
    await recovery.recoverOrg(ORG_B);
    expect(mockEnqueue.mock.calls[0][1].orgId).toBe(ORG_B);
    expect(repo.orphanCandidates.mock.calls[0][0]).toBe(ORG_B);
  });

  test('the remaining delay is preserved, not reset to zero', async () => {
    // Re-enqueueing a "three days before expiry" reminder with no delay would
    // deliver it the moment the sweep noticed.
    repo.orphanCandidates.mockResolvedValue([{ id: 'log-9', remainingDelayMs: 250_000 }]);
    await recovery.recoverOrg(ORG_A);
    expect(mockEnqueue.mock.calls[0][2].delay).toBe(250_000);
  });
});

describe('when the queue is the thing that is broken', () => {
  test('Redis still down: nothing is enqueued and it is reported, not thrown', async () => {
    // Very likely the reason these rows are stranded in the first place. The
    // next interval is the retry; a loop here would just spin.
    repo.orphanCandidates.mockResolvedValue([
      { id: 'log-1', remainingDelayMs: 0 },
      { id: 'log-2', remainingDelayMs: 0 },
    ]);
    mockEnsureReady.mockResolvedValue(false);

    const stats = await recovery.recoverOrg(ORG_A);

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockGetJob).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ candidates: 2, requeued: 0, unavailable: 2 });
  });

  test('an enqueue that returns null is counted, not mistaken for a success', async () => {
    repo.orphanCandidates.mockResolvedValue([{ id: 'log-1', remainingDelayMs: 0 }]);
    mockEnqueue.mockResolvedValue(null);

    const stats = await recovery.recoverOrg(ORG_A);
    expect(stats).toMatchObject({ requeued: 0, unavailable: 1 });
  });

  test('one bad row does not stop the rest of the studio', async () => {
    repo.orphanCandidates.mockResolvedValue([
      { id: 'log-1', remainingDelayMs: 0 },
      { id: 'log-2', remainingDelayMs: 0 },
      { id: 'log-3', remainingDelayMs: 0 },
    ]);
    mockGetJob.mockRejectedValueOnce(new Error('redis blew up'));

    const stats = await recovery.recoverOrg(ORG_A);
    expect(stats).toMatchObject({ candidates: 3, requeued: 2, failed: 1 });
  });

  test('Redis is not consulted at all when there is nothing to recover', async () => {
    // The common case, every fifteen minutes, on every studio.
    repo.orphanCandidates.mockResolvedValue([]);
    const stats = await recovery.recoverOrg(ORG_A);
    expect(mockEnsureReady).not.toHaveBeenCalled();
    expect(stats.candidates).toBe(0);
  });
});

describe('the sweep across studios', () => {
  test('only studios with automation switched on', async () => {
    repo.orgsWithAutomationOn.mockResolvedValue([]);
    const summary = await recovery.runRecovery();
    expect(repo.orphanCandidates).not.toHaveBeenCalled();
    expect(summary.orgs).toBe(0);
  });

  test('each studio is queried with its own id and nothing else', async () => {
    repo.orgsWithAutomationOn.mockResolvedValue([ORG_A, ORG_B]);
    repo.orphanCandidates.mockResolvedValue([{ id: 'log-1', remainingDelayMs: 0 }]);

    await recovery.runRecovery();

    expect(repo.orphanCandidates.mock.calls.map(([org]) => org)).toEqual([ORG_A, ORG_B]);
  });

  test('one studio failing does not end the run', async () => {
    repo.orgsWithAutomationOn.mockResolvedValue([ORG_A, ORG_B]);
    repo.orphanCandidates
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([{ id: 'log-2', remainingDelayMs: 0 }]);

    const summary = await recovery.runRecovery();

    expect(summary.skipped).toBe(1);
    expect(summary.requeued).toBe(1);
    expect(summary.byOrg[ORG_B]).toMatchObject({ requeued: 1 });
  });

  test('a studio with nothing stranded is not reported as swept', async () => {
    repo.orgsWithAutomationOn.mockResolvedValue([ORG_A]);
    repo.orphanCandidates.mockResolvedValue([]);
    const summary = await recovery.runRecovery();
    expect(summary.orgs).toBe(0);
    expect(summary.byOrg).toEqual({});
  });
});

describe('the time bounds', () => {
  test('the grace period defaults to fifteen minutes and is configurable', () => {
    expect(recovery.graceSeconds()).toBe(900);
    process.env.AUTOMATION_RECOVERY_GRACE_SEC = '60';
    expect(recovery.graceSeconds()).toBe(60);
    process.env.AUTOMATION_RECOVERY_GRACE_SEC = 'soon';
    expect(recovery.graceSeconds()).toBe(900);
  });

  test('the ceiling follows the gateway\'s send-once TTL', () => {
    // That ledger is what makes a re-drive safe. Reading the same env var the
    // gateway reads means the two cannot silently disagree about how long the
    // guarantee lasts.
    expect(recovery.maxAgeSeconds()).toBe(6 * 3600);
    process.env.WA_SEND_DEDUPE_TTL_SEC = '3600';
    expect(recovery.maxAgeSeconds()).toBe(3600);
    process.env.AUTOMATION_RECOVERY_MAX_AGE_SEC = '120';
    expect(recovery.maxAgeSeconds()).toBe(120);
  });

  test('both bounds are passed to the query', async () => {
    process.env.AUTOMATION_RECOVERY_GRACE_SEC = '300';
    process.env.AUTOMATION_RECOVERY_MAX_AGE_SEC = '7200';
    await recovery.recoverOrg(ORG_A);
    expect(repo.orphanCandidates).toHaveBeenCalledWith(ORG_A, {
      olderThanSec: 300,
      maxAgeSec: 7200,
    });
  });
});
