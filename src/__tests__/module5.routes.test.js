'use strict';
// Module 5 route boundary: studio scoping, role-specific mounting, and the
// request shapes the scheduler and journal accept. Arithmetic lives in the
// engines; this file is only what exists at HTTP.

const request = require('supertest');

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = global.__mockUser; next(); },
  requireTrainer: (_req, _res, next) => next(),
  requireClient: (_req, _res, next) => next(),
}));

const mockClientInOrg = jest.fn(async () => true);
jest.mock('../lib/orgGuard', () => ({ clientInOrg: (...a) => mockClientInOrg(...a) }));

jest.mock('../modules/progress/retests.service', () => ({
  ROSTER_STATES: ['missing_baseline', 'not_scheduled', 'upcoming', 'due', 'overdue', 'rescheduled'],
  rosterOverview: jest.fn(async () => ({ clients: [], counts: { total: 0 } })),
  getSettings: jest.fn(async () => ({ cadence_months: 4, reminder_days: [30, 14, 7], is_enabled: true })),
  saveSettings: jest.fn(async () => ({ cadence_months: 5, reminder_days: [30, 14, 7], is_enabled: true })),
  overview: jest.fn(async () => ({ assessment_count: 0, state: { state: 'missing_baseline' } })),
  startSchedule: jest.fn(async () => ({ id: 's1' })),
  reschedule: jest.fn(async () => ({ id: 's1' })),
  cancel: jest.fn(async () => ({ id: 's1' })),
  complete: jest.fn(async () => ({ id: 's1' })),
  comparisonFor: jest.fn(async () => ({ domains: [] })),
  timezoneFor: jest.fn(async () => 'Asia/Kolkata'),
}));

jest.mock('../modules/progress/habits.service', () => ({
  listLogs: jest.fn(async () => []),
  getLog: jest.fn(async () => null),
  upsertLog: jest.fn(async () => ({ id: 'l1' })),
  getPreferences: jest.fn(async () => ({ sleep_target_min: 7, sleep_target_max: 9 })),
  savePreferences: jest.fn(async () => ({ sleep_target_min: 7, sleep_target_max: 9 })),
  dashboard: jest.fn(async () => ({ today: '2026-10-19' })),
  memberDashboard: jest.fn(async () => ({ today: '2026-10-19' })),
  todayFor: jest.fn(async () => '2026-10-19'),
  reviewInsight: jest.fn(async () => ({ id: 'r1' })),
  listReviews: jest.fn(async () => []),
}));

const retests = require('../modules/progress/retests.service');
const habits = require('../modules/progress/habits.service');

function app() {
  const express = require('express');
  const a = express();
  a.use(express.json());
  a.use('/api/progress', require('../modules/progress/progress-module5.routes'));
  a.use('/api/me', require('../modules/progress/member-progress.routes'));
  return a;
}

const ORG = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
  mockClientInOrg.mockResolvedValue(true);
  global.__mockUser = { id: 'u-1', role: 'trainer', organization_id: ORG, pt_client_id: CLIENT };
});

describe('Module 5 trainer routes', () => {
  it('checks studio ownership before reading a client schedule', async () => {
    mockClientInOrg.mockResolvedValue(false);
    await request(app()).get(`/api/progress/clients/${CLIENT}/retest`).expect(404);
    expect(retests.overview).not.toHaveBeenCalled();
  });

  it('scopes the cross-client overview to the caller organization', async () => {
    await request(app()).get('/api/progress/module5/overview?search=asha&status=overdue&page=2&limit=10').expect(200);
    expect(retests.rosterOverview).toHaveBeenCalledWith(ORG, {
      search: 'asha', status: 'overdue', page: 2, limit: 10,
    });
  });

  it('rejects an unknown overview status before it reaches the service', async () => {
    await request(app()).get('/api/progress/module5/overview?status=archived').expect(400);
    expect(retests.rosterOverview).not.toHaveBeenCalled();
  });

  it('rejects a cadence outside the 4–6 month policy', async () => {
    await request(app()).put('/api/progress/module5/settings')
      .send({ cadence_months: 3, reminder_days: [30] }).expect(400);
    expect(retests.saveSettings).not.toHaveBeenCalled();
  });

  it('rejects a settings payload with no reminder stage', async () => {
    await request(app()).put('/api/progress/module5/settings')
      .send({ cadence_months: 4, reminder_days: [] }).expect(400);
    expect(retests.saveSettings).not.toHaveBeenCalled();
  });

  it('rejects a malformed dashboard date before it reaches SQL', async () => {
    await request(app()).get(`/api/progress/clients/${CLIENT}/habits/dashboard?date=19-10-2026`).expect(400);
    expect(habits.dashboard).not.toHaveBeenCalled();
  });

  it('rejects a dashboard window outside 7–90 days', async () => {
    await request(app()).get(`/api/progress/clients/${CLIENT}/habits/dashboard?days=365`).expect(400);
    expect(habits.dashboard).not.toHaveBeenCalled();
  });

  it('refuses a journal body that carries no values at all', async () => {
    await request(app()).post(`/api/progress/clients/${CLIENT}/habits`)
      .send({ log_date: '2026-10-19' }).expect(400);
    expect(habits.upsertLog).not.toHaveBeenCalled();
  });

  it('passes the caller organization, never a body organization, to the journal', async () => {
    await request(app()).post(`/api/progress/clients/${CLIENT}/habits`)
      .send({ log_date: '2026-10-19', sleep_hours: 7.5, organization_id: 'attacker-org' }).expect(200);
    expect(habits.upsertLog).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, clientId: CLIENT, logDate: '2026-10-19', userId: 'u-1',
    }));
    const payload = habits.upsertLog.mock.calls[0][0];
    expect(payload.values.organization_id).toBeUndefined();
  });
});

describe('Module 5 member routes', () => {
  beforeEach(() => {
    global.__mockUser = { id: 'u-2', role: 'client', organization_id: ORG, pt_client_id: CLIENT };
  });

  it('uses the client id on the token for the dashboard', async () => {
    await request(app()).get('/api/me/progress?days=7').expect(200);
    expect(habits.memberDashboard).toHaveBeenCalledWith(ORG, CLIENT, expect.objectContaining({ days: 7 }));
  });

  it('strips tenant and audit identifiers from the member progress payloads', async () => {
    habits.memberDashboard.mockResolvedValueOnce({
      today: '2026-10-19',
      schedule: { id: 's1', organization_id: ORG, created_by: 'u-1', updated_by: 'u-1', scheduled_date: '2026-11-18' },
      assessment: { count: 1, baseline: { id: 'a1', organization_id: ORG, trainer_id: 'u-1', weight: 80 } },
    });
    retests.overview.mockResolvedValueOnce({
      state: { state: 'upcoming' },
      schedule: { id: 's1', organization_id: ORG, completed_by: 'u-1' },
    });
    retests.comparisonFor.mockResolvedValueOnce({
      baseline: { id: 'a1', organization_id: ORG, trainer_notes: 'visible note' },
      domains: [],
    });

    const dashboard = await request(app()).get('/api/me/progress').expect(200);
    expect(dashboard.body.data.schedule).toEqual({
      id: 's1', scheduled_date: '2026-11-18',
    });
    expect(dashboard.body.data.assessment.baseline).toEqual({ id: 'a1', weight: 80 });

    const retest = await request(app()).get('/api/me/progress/retest').expect(200);
    expect(retest.body.data.schedule).toEqual({ id: 's1' });

    const comparison = await request(app()).get('/api/me/progress/comparison').expect(200);
    expect(comparison.body.data.baseline).toEqual({ id: 'a1', trainer_notes: 'visible note' });
  });

  it('rejects a malformed day on the single-day journal read', async () => {
    await request(app()).get('/api/me/habits/today?date=2026-13-40').expect(400);
    expect(habits.getLog).not.toHaveBeenCalled();
  });

  it('saves the member journal under the token organization and client', async () => {
    await request(app()).post('/api/me/habits')
      .send({ log_date: '2026-10-19', steps: 8000, steps_source: 'manual' }).expect(200);
    expect(habits.upsertLog).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, clientId: CLIENT, userId: 'u-2',
    }));
  });

  it('refuses to write a journal row for another client or forge imported provenance', async () => {
    await request(app()).post('/api/me/habits')
      .send({
        log_date: '2026-10-19', client_id: 'someone-else', source: 'wearable',
        steps: 8000, steps_source: 'imported',
      }).expect(200);
    expect(habits.upsertLog).toHaveBeenCalledWith(expect.objectContaining({
      clientId: CLIENT,
    }));
    const values = habits.upsertLog.mock.calls[0][0].values;
    expect(values.client_id).toBeUndefined();
    expect(values.source).toBeUndefined();
    expect(values.steps_source).toBeUndefined();
  });
});
