'use strict';
// The automation worker's job routing and cron registration.
//
// Small, but the thing it guards is not: a job name this processor does not
// recognise throws, and a scheduler that was never registered means a sweep
// that silently never runs. Both are invisible in production — the symptom of
// each is an absence of messages.

const mockRunSweep = jest.fn();
const mockRunRecovery = jest.fn();
jest.mock('../modules/automation/automation.sweep', () => ({ runSweep: (...a) => mockRunSweep(...a) }));
jest.mock('../modules/automation/automation.recovery', () => ({ runRecovery: (...a) => mockRunRecovery(...a) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockUpsert = jest.fn();
jest.mock('../jobs/queue', () => ({
  automationSweepQueue: { upsertJobScheduler: (...a) => mockUpsert(...a) },
}));

const worker = require('../workers/automation.worker');

beforeEach(() => {
  jest.clearAllMocks();
  mockRunSweep.mockResolvedValue({ orgs: 1 });
  mockRunRecovery.mockResolvedValue({ orgs: 1, requeued: 2 });
  mockUpsert.mockResolvedValue({});
  delete process.env.AUTOMATION_SWEEP_CRON;
  delete process.env.AUTOMATION_RECOVERY_CRON;
});

describe('job routing', () => {
  test('the daily job runs the sweep and nothing else', async () => {
    await worker.processSweepJob({ name: 'daily' });
    expect(mockRunSweep).toHaveBeenCalledTimes(1);
    expect(mockRunRecovery).not.toHaveBeenCalled();
  });

  test('the recovery job runs the recovery and nothing else', async () => {
    await worker.processSweepJob({ name: 'recovery' });
    expect(mockRunRecovery).toHaveBeenCalledTimes(1);
    expect(mockRunSweep).not.toHaveBeenCalled();
  });

  test('an unknown job name throws rather than silently succeeding', async () => {
    // A job that returns quietly for a name nobody handles is a scheduler
    // firing into nothing, which looks healthy from every angle.
    await expect(worker.processSweepJob({ name: 'whatever' })).rejects.toThrow(/Unknown automation job/);
  });
});

describe('cron registration', () => {
  test('both schedulers are registered, each with its own id', async () => {
    await worker.scheduleAutomationSweep();

    const ids = mockUpsert.mock.calls.map(([id]) => id);
    expect(ids).toEqual([worker.SWEEP_JOB_ID, worker.RECOVERY_JOB_ID]);
    // Distinct ids, or the second upsert would overwrite the first and one of
    // the two passes would simply stop existing.
    expect(worker.SWEEP_JOB_ID).not.toBe(worker.RECOVERY_JOB_ID);
  });

  test('the job names match what the processor routes on', async () => {
    // The one way these two halves can drift apart: a scheduler registered
    // under a name processSweepJob does not handle throws on every fire.
    await worker.scheduleAutomationSweep();
    const names = mockUpsert.mock.calls.map(([, , opts]) => opts.name);
    expect(names).toEqual(['daily', 'recovery']);
    for (const name of names) {
      await expect(worker.processSweepJob({ name })).resolves.toBeDefined();
    }
  });

  test('recovery runs far more often than the daily sweep', async () => {
    // It repairs an outage. Waiting until tomorrow morning to notice a
    // stranded message would make the repair useless for anything
    // time-sensitive, which is most of what automation sends.
    await worker.scheduleAutomationSweep();
    const [[, sweepRepeat], [, recoveryRepeat]] = mockUpsert.mock.calls;
    expect(sweepRepeat.pattern).toBe(worker.DEFAULT_SWEEP_CRON);
    expect(recoveryRepeat.pattern).toBe(worker.DEFAULT_RECOVERY_CRON);
    expect(worker.DEFAULT_RECOVERY_CRON).toMatch(/^\*\/\d+ \* \* \* \*$/);
  });

  test('both crons are configurable', async () => {
    process.env.AUTOMATION_SWEEP_CRON = '0 4 * * *';
    process.env.AUTOMATION_RECOVERY_CRON = '*/5 * * * *';
    await worker.scheduleAutomationSweep();
    expect(mockUpsert.mock.calls[0][1].pattern).toBe('0 4 * * *');
    expect(mockUpsert.mock.calls[1][1].pattern).toBe('*/5 * * * *');
  });

  test('neither pass retries inside itself', async () => {
    // Both are idempotent by construction and both fail for reasons a backoff
    // cannot clear — Postgres unreachable, Redis unreachable. The next
    // interval is the retry, and a missed pass is visible in the logs rather
    // than hidden behind three silent attempts.
    await worker.scheduleAutomationSweep();
    for (const [, , opts] of mockUpsert.mock.calls) {
      expect(opts.opts.attempts).toBe(1);
    }
  });
});
