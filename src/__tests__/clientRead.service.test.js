'use strict';

jest.mock('../db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock('../lib/screeningGate', () => ({
  screeningSummary: jest.fn(),
}));

jest.mock('../modules/pt-os/training-brief', () => ({
  buildBrief: jest.fn(),
}));

jest.mock('../modules/pt-os/client-snapshot', () => ({
  buildSnapshot: jest.fn(),
}));

jest.mock('../modules/pt-os/recovery', () => ({
  buildRecovery: jest.fn(),
}));

jest.mock('../modules/pt-os/pt-os.service', () => ({
  getClientAttendance: jest.fn(),
  getClientPayments: jest.fn(),
}));

const pool = require('../db/pool');
const { screeningSummary } = require('../lib/screeningGate');
const { buildBrief } = require('../modules/pt-os/training-brief');
const { buildSnapshot } = require('../modules/pt-os/client-snapshot');
const { buildRecovery } = require('../modules/pt-os/recovery');
const svc = require('../modules/pt-os/pt-os.service');

const {
  findVisibleClient,
  getClientProfile,
  getClientSnapshot,
  getClientTrainingBrief,
  getClientSubscriptions,
  getClientRenewals,
  getClientCommunication,
  getClientAttendance,
  getClientPayments,
} = require('../modules/pt-os/client-read.service');

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const FOREIGN_CLIENT_ID = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('findVisibleClient', () => {
  it('returns {id, name} when client exists in org', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: CLIENT_ID, name: 'Test Client' }],
    });

    const result = await findVisibleClient(ORG_ID, CLIENT_ID);

    expect(result).toEqual({ id: CLIENT_ID, name: 'Test Client' });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id, name FROM pt_clients'),
      [CLIENT_ID, ORG_ID]
    );
  });

  it('returns null when no row found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await findVisibleClient(ORG_ID, CLIENT_ID);

    expect(result).toBeNull();
  });

  it('returns null when client belongs to different org (soft-deleted)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await findVisibleClient(ORG_ID, FOREIGN_CLIENT_ID);

    expect(result).toBeNull();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('organization_id = $2'),
      [FOREIGN_CLIENT_ID, ORG_ID]
    );
  });

  it('binds orgId as second parameter', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await findVisibleClient(ORG_ID, CLIENT_ID);

    const call = pool.query.mock.calls[0];
    expect(call[1]).toEqual([CLIENT_ID, ORG_ID]);
  });
});

describe('getClientProfile', () => {
  it('returns null for foreign client and never calls screeningSummary', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // findVisibleClient

    const result = await getClientProfile(ORG_ID, FOREIGN_CLIENT_ID);

    expect(result).toBeNull();
    expect(screeningSummary).not.toHaveBeenCalled();
  });

  it('returns profile with screening for visible client', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client' }] }) // findVisibleClient
      .mockResolvedValueOnce({
        rows: [{
          id: CLIENT_ID,
          name: 'Test Client',
          final_amount: 10000,
          paid_amount: 5000,
          pt_end_date: '2026-12-31',
          current_term_fee: 10000,
          current_term_paid: 5000,
          current_term_balance: 5000,
          due_status: 'DUE',
        }],
      }); // profile query

    screeningSummary.mockResolvedValueOnce({
      consent: { status: 'completed' },
      parq: { status: 'submitted', risk_level: 'low' },
      block: null,
      warnings: [],
      complete: true,
    });

    const result = await getClientProfile(ORG_ID, CLIENT_ID);

    expect(result).toBeTruthy();
    expect(result.id).toBe(CLIENT_ID);
    expect(result.screening).toBeTruthy();
    expect(screeningSummary).toHaveBeenCalledWith(CLIENT_ID);
  });

  it('profile query includes hasPtTermSql and priorTermsPaidJoin', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client' }] })
      .mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client' }] });

    screeningSummary.mockResolvedValueOnce({ consent: {}, parq: {}, block: null, warnings: [], complete: true });

    await getClientProfile(ORG_ID, CLIENT_ID);

    const profileQuery = pool.query.mock.calls[1][0];
    expect(profileQuery).toContain('has_pt_term');
    expect(profileQuery).toContain('prior.paid');
    expect(profileQuery).toContain('current_term_fee');
    expect(profileQuery).toContain('current_term_paid');
    expect(profileQuery).toContain('current_term_balance');
    expect(profileQuery).toContain('due_status');
  });
});

describe('getClientSubscriptions', () => {
  it('returns null for foreign client (not [])', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // findVisibleClient

    const result = await getClientSubscriptions(ORG_ID, FOREIGN_CLIENT_ID);

    expect(result).toBeNull();
  });

  it('returns subscription rows for visible client', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client' }] }) // findVisibleClient
      .mockResolvedValueOnce({
        rows: [
          { id: 'sub1', plan_name: 'Plan A', start_date: '2026-01-01' },
          { id: 'sub2', plan_name: 'Plan B', start_date: '2026-07-01' },
        ],
      }); // subscriptions query

    const result = await getClientSubscriptions(ORG_ID, CLIENT_ID);

    expect(result).toHaveLength(2);
    expect(result[0].plan_name).toBe('Plan A');
  });
});

describe('getClientRenewals', () => {
  it('returns null for foreign client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await getClientRenewals(ORG_ID, FOREIGN_CLIENT_ID);

    expect(result).toBeNull();
  });

  it('returns renewal rows for visible client', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'ren1', renewed_at: '2026-06-01', amount: 10000 }],
      });

    const result = await getClientRenewals(ORG_ID, CLIENT_ID);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ren1');
  });
});

describe('getClientCommunication', () => {
  it('returns null for foreign client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await getClientCommunication(ORG_ID, FOREIGN_CLIENT_ID);

    expect(result).toBeNull();
  });

  it('returns communication rows for visible client', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'comm1', channel: 'whatsapp', direction: 'outbound' }],
      });

    const result = await getClientCommunication(ORG_ID, CLIENT_ID);

    expect(result).toHaveLength(1);
    expect(result[0].channel).toBe('whatsapp');
  });
});

describe('getClientSnapshot', () => {
  it('returns null for foreign client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await getClientSnapshot(ORG_ID, FOREIGN_CLIENT_ID);

    expect(result).toBeNull();
    expect(buildSnapshot).not.toHaveBeenCalled();
    expect(buildRecovery).not.toHaveBeenCalled();
  });

  it('calls buildSnapshot and buildRecovery with loaded rows for visible client', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client' }] }) // findVisibleClient
      .mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client', pt_end_date: '2026-12-31', current_term_balance: 5000 }] }) // client row
      .mockResolvedValueOnce({ rows: [{ sleep_category: 'good', sleep_duration_hours: 8 }] }) // lifestyle
      .mockResolvedValueOnce({ rows: [{ weight_kg: 70, measured_at: '2026-01-15' }] }) // measurements
      .mockResolvedValueOnce({ rows: [{ weight: 71, assessment_date: '2026-01-10' }] }) // assessments
      .mockResolvedValueOnce({ rows: [{ goal_type: 'weight_loss', target_weight: 65 }] }) // goal
      .mockResolvedValueOnce({ rows: [{ exercise_name: 'Bench', weight_kg: 100, reps: 5, session_date: '2026-01-14' }] }) // prRows
      .mockResolvedValueOnce({ rows: [{ session_date: '2026-01-14', status: 'completed' }] }) // lastSession
      .mockResolvedValueOnce({ rows: [{ week_start_date: '2026-01-12', sleep_hours: 8 }] }); // checkins

    buildSnapshot.mockReturnValue({ alerts: [], goal: { present: true }, prs: [], coach: [] });
    buildRecovery.mockReturnValue({ present: true, score: 85, weeks: [] });

    const result = await getClientSnapshot(ORG_ID, CLIENT_ID);

    expect(buildSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      client: expect.objectContaining({ id: CLIENT_ID }),
      lifestyle: expect.any(Object),
      measurements: expect.any(Array),
      assessments: expect.any(Array),
      goal: expect.any(Object),
      prRows: expect.any(Array),
      lastSession: expect.any(Object),
    }));
    expect(buildRecovery).toHaveBeenCalledWith(expect.any(Array));
    expect(result).toMatchObject({
      alerts: [],
      goal: { present: true },
      recovery: { present: true, score: 85 },
    });
  });
});

describe('getClientTrainingBrief', () => {
  it('returns null for foreign client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await getClientTrainingBrief(ORG_ID, FOREIGN_CLIENT_ID);

    expect(result).toBeNull();
    expect(buildBrief).not.toHaveBeenCalled();
  });

  it('calls buildBrief with all assessment rows for visible client', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client' }] }) // findVisibleClient
      .mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client', gender: 'M', dob: '1990-01-01' }] }) // client
      .mockResolvedValueOnce({ rows: [{ risk_level: 'low' }] }) // parq
      .mockResolvedValueOnce({ rows: [{ weight: 70 }] }) // assessment
      .mockResolvedValueOnce({ rows: [{ posture_risk_level: 'low' }] }) // posture
      .mockResolvedValueOnce({ rows: [{ mobility_score: 80 }] }) // mobility
      .mockResolvedValueOnce({ rows: [{ sleep_duration_hours: 8 }] }) // lifestyle
      .mockResolvedValueOnce({ rows: [{ goal_type: 'weight_loss' }] }) // goal
      .mockResolvedValueOnce({ rows: [{ plan_id: 'plan1', plan_name: 'Plan A' }] }) // assignment
      .mockResolvedValueOnce({ rows: [{ status: 'completed' }] }); // sessions

    buildBrief.mockReturnValue({ client: { id: CLIENT_ID }, sections: {}, missing: [], stale: [] });

    const result = await getClientTrainingBrief(ORG_ID, CLIENT_ID);

    expect(buildBrief).toHaveBeenCalledWith(expect.objectContaining({
      client: expect.objectContaining({ id: CLIENT_ID }),
      parq: expect.any(Object),
      assessment: expect.any(Object),
      posture: expect.any(Object),
      mobility: expect.any(Object),
      lifestyle: expect.any(Object),
      goal: expect.any(Object),
      assignment: expect.any(Object),
      recentSessions: expect.any(Array),
    }));
    expect(result).toEqual(expect.objectContaining({ client: { id: CLIENT_ID } }));
  });
});

describe('getClientAttendance', () => {
  it('returns null for foreign client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await getClientAttendance(ORG_ID, FOREIGN_CLIENT_ID);

    expect(result).toBeNull();
    expect(svc.getClientAttendance).not.toHaveBeenCalled();
  });

  it('calls pt-os.service.getClientAttendance with default paging for visible client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client' }] });
    svc.getClientAttendance.mockResolvedValueOnce([
      { id: 'att1', date: '2026-01-15', check_in_time: '06:00:00' },
    ]);

    const result = await getClientAttendance(ORG_ID, CLIENT_ID);

    expect(svc.getClientAttendance).toHaveBeenCalledWith(CLIENT_ID, { limit: 200, offset: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('att1');
  });
});

describe('getClientPayments', () => {
  it('returns null for foreign client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await getClientPayments(ORG_ID, FOREIGN_CLIENT_ID);

    expect(result).toBeNull();
    expect(svc.getClientPayments).not.toHaveBeenCalled();
  });

  it('calls pt-os.service.getClientPayments with default paging for visible client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: CLIENT_ID, name: 'Test Client' }] });
    svc.getClientPayments.mockResolvedValueOnce([
      { id: 'pay1', amount: 5000, method: 'UPI', date: '2026-01-15' },
    ]);

    const result = await getClientPayments(ORG_ID, CLIENT_ID);

    expect(svc.getClientPayments).toHaveBeenCalledWith(CLIENT_ID, { limit: 200, offset: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(5000);
  });
});

describe('Organization scoping', () => {
  it('every query includes organization_id predicate for client lookup', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await findVisibleClient(ORG_ID, CLIENT_ID);
    await getClientProfile(ORG_ID, CLIENT_ID);
    await getClientSnapshot(ORG_ID, CLIENT_ID);
    await getClientTrainingBrief(ORG_ID, CLIENT_ID);
    await getClientSubscriptions(ORG_ID, CLIENT_ID);
    await getClientRenewals(ORG_ID, CLIENT_ID);
    await getClientCommunication(ORG_ID, CLIENT_ID);
    await getClientAttendance(ORG_ID, CLIENT_ID);
    await getClientPayments(ORG_ID, CLIENT_ID);

    // All calls should have gone through findVisibleClient which has the org predicate
    const findVisibleCalls = pool.query.mock.calls.filter(call =>
      call[0].includes('SELECT id, name FROM pt_clients')
    );
    expect(findVisibleCalls.length).toBeGreaterThanOrEqual(9);

    findVisibleCalls.forEach(call => {
      expect(call[0]).toContain('organization_id = $2');
      expect(call[1][1]).toBe(ORG_ID);
    });
  });
});