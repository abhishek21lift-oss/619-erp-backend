'use strict';

jest.mock('../modules/progress/retests.repo', () => ({
  getSettings: jest.fn(),
  upsertSettings: jest.fn(),
  orgTimezone: jest.fn(),
  listAssessments: jest.fn(),
  getAssessment: jest.fn(),
  activeSchedule: jest.fn(),
  listSchedules: jest.fn(),
  getSchedule: jest.fn(),
  createSchedule: jest.fn(),
  completeSchedule: jest.fn(),
  reschedule: jest.fn(),
  cancel: jest.fn(),
  openSchedulesForSweep: jest.fn(),
  claimReminder: jest.fn(),
  markReminder: jest.fn(),
  syncStatus: jest.fn(),
}));

const repo = require('../modules/progress/retests.repo');
const service = require('../modules/progress/retests.service');

const ASSESSMENT = {
  id: 'a1', assessment_date: '2026-01-31', assessment_type: 'initial',
  assessment_number: 1, overall_fitness_score: 42,
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.orgTimezone.mockResolvedValue('Asia/Kolkata');
  repo.listAssessments.mockResolvedValue([]);
  repo.listSchedules.mockResolvedValue([]);
  repo.activeSchedule.mockResolvedValue(null);
  repo.getSettings.mockResolvedValue(null);
  repo.syncStatus.mockResolvedValue(undefined);
});

describe('Module 5 re-test service', () => {
  it('says a client with no assessment has no baseline', async () => {
    const out = await service.overview('org-1', 'client-1');
    expect(out.state).toEqual({ state: 'missing_baseline', days_until: null, label: 'No baseline assessment' });
    expect(out.schedule).toBeNull();
    expect(out.assessment_count).toBe(0);
    expect(out.prompt).toMatch(/initial fitness assessment/i);
  });

  it('does not invent a schedule on read for a pre-existing assessment', async () => {
    repo.listAssessments.mockResolvedValue([ASSESSMENT]);
    const out = await service.overview('org-1', 'client-1');
    expect(out.state.state).toBe('not_scheduled');
    expect(out.baseline.id).toBe('a1');
    expect(repo.createSchedule).not.toHaveBeenCalled();
  });

  it('opens the next cycle from the completed assessment and clamps month-end', async () => {
    repo.getSettings.mockResolvedValue({ cadence_months: 5, reminder_days: [30, 14, 7], is_enabled: true });
    repo.createSchedule.mockResolvedValue({
      id: 's1', baseline_assessment_id: 'a1', scheduled_date: '2026-06-30',
      cadence_months: 5, status: 'upcoming',
    });
    const out = await service.syncAfterAssessment({ orgId: 'org-1', clientId: 'client-1', assessment: ASSESSMENT });
    expect(out.completed_previous).toBeNull();
    expect(repo.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      scheduledDate: '2026-06-30', cadenceMonths: 5, baselineAssessmentId: 'a1',
    }));
  });

  it('closes the open cycle and opens the next one', async () => {
    repo.getSettings.mockResolvedValue({ cadence_months: 4, reminder_days: [30, 14, 7], is_enabled: true });
    repo.activeSchedule.mockResolvedValue({
      id: 's1', baseline_assessment_id: 'a1', scheduled_date: '2026-05-31', status: 'upcoming',
    });
    repo.getAssessment.mockResolvedValue(ASSESSMENT);
    repo.completeSchedule.mockResolvedValue({ id: 's1', status: 'completed' });
    repo.createSchedule.mockResolvedValue({
      id: 's2', baseline_assessment_id: 'a2', scheduled_date: '2026-10-30',
      cadence_months: 4, status: 'upcoming',
    });
    const next = { ...ASSESSMENT, id: 'a2', assessment_date: '2026-06-30' };
    const out = await service.syncAfterAssessment({ orgId: 'org-1', clientId: 'client-1', assessment: next });
    expect(repo.completeSchedule).toHaveBeenCalledWith('org-1', 's1', 'a2', null);
    expect(out.completed_previous).toBe('s1');
    expect(out.schedule.id).toBe('s2');
  });

  it('does not move the chain backwards for a backdated assessment', async () => {
    repo.activeSchedule.mockResolvedValue({
      id: 's1', baseline_assessment_id: 'a1', scheduled_date: '2026-05-31', status: 'upcoming',
    });
    repo.getAssessment.mockResolvedValue(ASSESSMENT);
    const old = { ...ASSESSMENT, id: 'a0', assessment_date: '2025-12-01' };
    const out = await service.syncAfterAssessment({ orgId: 'org-1', clientId: 'client-1', assessment: old });
    expect(repo.completeSchedule).not.toHaveBeenCalled();
    expect(repo.createSchedule).not.toHaveBeenCalled();
    expect(out.schedule.id).toBe('s1');
  });

  it('is idempotent when the same assessment is posted again', async () => {
    repo.activeSchedule.mockResolvedValue({
      id: 's1', baseline_assessment_id: 'a1', scheduled_date: '2026-05-31', status: 'upcoming',
    });
    const out = await service.syncAfterAssessment({ orgId: 'org-1', clientId: 'client-1', assessment: ASSESSMENT });
    expect(out.schedule.id).toBe('s1');
    expect(repo.completeSchedule).not.toHaveBeenCalled();
    expect(repo.createSchedule).not.toHaveBeenCalled();
  });

  it('marks a manual completion and opens the next cycle from that assessment', async () => {
    const next = { ...ASSESSMENT, id: 'a2', assessment_date: '2026-06-30' };
    repo.getSchedule.mockResolvedValue({ id: 's1', status: 'upcoming' });
    repo.getAssessment.mockResolvedValue(next);
    repo.listAssessments.mockResolvedValue([ASSESSMENT, next]);
    repo.completeSchedule.mockResolvedValue({ id: 's1', status: 'completed' });
    repo.createSchedule.mockResolvedValue({
      id: 's2', baseline_assessment_id: 'a2', scheduled_date: '2026-10-30',
      cadence_months: 4, status: 'upcoming',
    });
    const out = await service.complete('org-1', 'client-1', 's1', 'a2', 'u-1');
    expect(out.status).toBe('completed');
    expect(repo.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      baselineAssessmentId: 'a2', source: 'auto',
    }));
  });

  it('refuses to close a cycle with the baseline test itself', async () => {
    repo.getSchedule.mockResolvedValue({ id: 's1', status: 'upcoming', baseline_assessment_id: 'a1' });
    repo.getAssessment.mockResolvedValue(ASSESSMENT);
    repo.listAssessments.mockResolvedValue([ASSESSMENT]);

    await expect(service.complete('org-1', 'client-1', 's1', 'a1', 'u-1'))
      .rejects.toMatchObject({ status: 409, code: 'BASELINE_IS_NOT_RETEST' });
    expect(repo.completeSchedule).not.toHaveBeenCalled();
    expect(repo.createSchedule).not.toHaveBeenCalled();
  });

  it('refuses to complete a cycle with an older test than the latest', async () => {
    const latest = { ...ASSESSMENT, id: 'a2', assessment_date: '2026-06-30' };
    const older = { ...ASSESSMENT, id: 'a0', assessment_date: '2025-12-01' };
    repo.getSchedule.mockResolvedValue({ id: 's1', status: 'upcoming' });
    repo.getAssessment.mockResolvedValue(older);
    repo.listAssessments.mockResolvedValue([ASSESSMENT, latest]);

    await expect(service.complete('org-1', 'client-1', 's1', 'a0', 'u-1'))
      .rejects.toMatchObject({ status: 409, code: 'NOT_LATEST_ASSESSMENT' });
    expect(repo.completeSchedule).not.toHaveBeenCalled();
    expect(repo.createSchedule).not.toHaveBeenCalled();
  });

  it('rejects a reschedule date in the past', async () => {
    await expect(service.reschedule('org-1', 'client-1', 's1', { scheduledDate: '2020-01-01' }))
      .rejects.toMatchObject({ status: 400, code: 'DATE_IN_PAST' });
    expect(repo.reschedule).not.toHaveBeenCalled();
  });

  it('returns the stored rescheduled state, not a new row', async () => {
    repo.reschedule.mockResolvedValue({
      id: 's1', scheduled_date: '2026-12-01', status: 'rescheduled',
      rescheduled_from: '2026-10-01',
    });
    const out = await service.reschedule('org-1', 'client-1', 's1', { scheduledDate: '2026-12-01', reason: 'Travel' });
    expect(out).toMatchObject({ id: 's1', status: 'rescheduled', scheduled_date: '2026-12-01' });
  });

  it('reports the live state for the open cycle inside history', async () => {
    repo.listAssessments.mockResolvedValue([ASSESSMENT]);
    repo.activeSchedule.mockResolvedValue({
      id: 's1', baseline_assessment_id: 'a1', scheduled_date: '2020-01-01',
      cadence_months: 4, status: 'upcoming',
    });
    repo.listSchedules.mockResolvedValue([{
      id: 's1', baseline_assessment_id: 'a1', scheduled_date: '2020-01-01',
      cadence_months: 4, status: 'upcoming',
    }]);
    const out = await service.overview('org-1', 'client-1');
    expect(out.state.state).toBe('overdue');
    expect(out.history[0].status).toBe('overdue');
  });

  it('requires two distinct assessments for a comparison', async () => {
    repo.listAssessments.mockResolvedValue([ASSESSMENT]);
    await expect(service.comparisonFor('org-1', 'client-1'))
      .rejects.toMatchObject({ status: 400, code: 'SAME_ASSESSMENT' });
  });

  it('compares the earliest and latest assessments by default', async () => {
    repo.listAssessments.mockResolvedValue([
      ASSESSMENT,
      { ...ASSESSMENT, id: 'a2', assessment_number: 2, assessment_date: '2026-06-30', weight: 78 },
    ]);
    const out = await service.comparisonFor('org-1', 'client-1');
    expect(out.baseline.id).toBe('a1');
    expect(out.latest.id).toBe('a2');
    expect(out.domains).toHaveLength(7);
    expect(out.previous_comparison).toBeNull();
  });

  it('compares the latest test with the one immediately before it', async () => {
    repo.listAssessments.mockResolvedValue([
      ASSESSMENT,
      { ...ASSESSMENT, id: 'a2', assessment_number: 2, assessment_date: '2026-06-30', weight: 78 },
      { ...ASSESSMENT, id: 'a3', assessment_number: 3, assessment_date: '2026-10-30', weight: 76 },
    ]);
    const out = await service.comparisonFor('org-1', 'client-1');
    expect(out.baseline.id).toBe('a1');
    expect(out.latest.id).toBe('a3');
    expect(out.previous_comparison.baseline.id).toBe('a2');
    expect(out.previous_comparison.latest.id).toBe('a3');
    expect(out.previous_comparison.previous_comparison).toBeUndefined();
  });
});
