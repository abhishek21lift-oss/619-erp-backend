'use strict';
// The unified Client 360 read: aggregation, missing data, session balance and
// the tenant gate. CI has no database for this suite, so the pool is mocked and
// the assertions are about the shape and the binds the service would send.

jest.mock('../db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../modules/pt-os/client-read.service', () => ({
  getClientProfile: jest.fn(),
}));

jest.mock('../modules/pt-os/authoritative-client', () => ({
  loadClientSources: jest.fn(),
}));

jest.mock('../modules/pt-os/client-snapshot', () => {
  const actual = jest.requireActual('../modules/pt-os/client-snapshot');
  return { ...actual, buildSnapshot: jest.fn() };
});

jest.mock('../modules/pt-os/recovery', () => ({
  buildRecovery: jest.fn(),
}));

jest.mock('../modules/pt-os/training-brief', () => ({
  buildBrief: jest.fn(),
}));

const pool = require('../db/pool');
const { getClientProfile } = require('../modules/pt-os/client-read.service');
const { loadClientSources } = require('../modules/pt-os/authoritative-client');
const { buildSnapshot } = require('../modules/pt-os/client-snapshot');
const { buildRecovery } = require('../modules/pt-os/recovery');
const { buildBrief } = require('../modules/pt-os/training-brief');
const { buildClient360, getClient360 } = require('../modules/pt-os/client-360.service');

const ORG = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-11-13';

function profileFixture(overrides = {}) {
  return {
    id: CLIENT,
    name: 'Hari Narayan Singh',
    unique_id: 'PT-001',
    gender: 'male',
    mobile: '9876543210',
    email: 'hari@example.com',
    trainer_name: 'Ajeet',
    status: 'active',
    goal: 'fat_loss',
    weight: '84.00',
    body_fat: '23.0',
    package_type: 'monthly',
    pt_start_date: '2026-08-01',
    pt_end_date: '2026-12-01',
    days_left: 18,
    due_status: 'DUE',
    current_term_fee: '30000',
    current_term_paid: '25000',
    current_term_balance: '5000',
    balance_amount: '5000',
    ...overrides,
  };
}

function briefFixture(overrides = {}) {
  return {
    client: { id: CLIENT, name: 'Hari Narayan Singh', age: 34, gender: 'male', notes: 'Left knee — no deep lunges.', goal: 'fat_loss' },
    sections: {
      readiness: { present: true, as_of: '2026-10-01', risk_level: 'low', gate_status: 'cleared' },
      body: {
        present: true, as_of: '2026-11-01', weight_kg: 82, bmi: 26.1, body_fat_pct: 22.5,
        lean_mass_kg: 63.5, waist_cm: 92,
      },
      capacity: {
        present: true, as_of: '2026-11-01', overall: 68,
        strength: { score: 22, category: 'Good', max: 30 },
        cardio: { score: 18, category: 'Fair', max: 30 },
        endurance: { score: 14, category: 'Good', max: 20 },
        flexibility: { score: 11, category: 'Good', max: 15 },
      },
      limitations: { present: true, injuries: 'Left knee', posture: null, mobility: null },
      lifestyle: { present: true, as_of: '2026-10-01', sleep_hours: 7 },
      goal: {
        present: true, goal_type: 'fat_loss', target_weight: 75, starting_weight: 85,
        target_date: '2027-02-01', as_of: '2026-09-01',
      },
      history: {
        present: true, plan_id: 'plan-1', plan_name: 'Hypertrophy A',
        started_on: '2026-10-01', progress_pct: 40,
      },
    },
    missing: [], stale: [], completeness_pct: 100,
    ...overrides,
  };
}

function sourcesFixture(overrides = {}) {
  return {
    client: profileFixture(),
    lifestyle: { sleep_duration_hours: 7 },
    measurements: [],
    assessments: [
      { id: 'as-2', assessment_date: '2026-11-01', weight: '82.00' },
      { id: 'as-1', assessment_date: '2026-09-01', weight: '85.00' },
    ],
    goal: { goal_type: 'fat_loss', target_weight: '75', starting_weight: '85' },
    prRows: [],
    lastSession: { session_date: '2026-11-12', status: 'completed' },
    checkins: [
      { week_start_date: '2026-11-09', weight: '82.00', mood: 'good' },
      { week_start_date: '2026-11-02', weight: '82.50', mood: 'ok' },
    ],
    sessions: [
      { status: 'completed', session_date: '2026-11-12' },
      { status: 'in_progress', session_date: '2026-11-10' },
    ],
    parq: { risk_level: 'low' },
    posture: null,
    mobility: null,
    assignment: { plan_name: 'Hypertrophy A' },
    latestAssessment: { assessment_date: '2026-11-01', weight: '82.00' },
    ...overrides,
  };
}

const snapshotFixture = () => ({
  alerts: [{ id: 'pending_payment', severity: 'warning', label: 'Pending payment', detail: '₹5,000 outstanding', href: null }],
  goal: { present: true, goal_type: 'fat_loss', target_kg: 75, current_kg: 82, start_kg: 85, pct: 30 },
  prs: [],
  coach: [{ id: 'on_track', tone: 'good', text: 'On track: 30% of the way to 75 kg.', because: 'Weight log · last reading 2026-11-01' }],
  baseline_done: true,
});

const attendanceFixture = () => [
  { id: 'att-3', date: '2026-11-10', status: 'present', method: 'qr', check_in_time: '06:02:00' },
  { id: 'att-2', date: '2026-10-20', status: 'present', method: 'manual', check_in_time: '06:10:00' },
  { id: 'att-1b', date: '2026-09-01', status: 'present', method: 'manual', check_in_time: '06:05:00' },
  { id: 'att-1', date: '2026-08-01', status: 'absent', method: 'manual', check_in_time: null },
];

const paymentsFixture = () => ([
  { id: 'pay-2', amount: '15000', method: 'UPI', date: '2026-11-05', receipt_no: 'R-2', notes: null },
  { id: 'pay-1', amount: '10000', method: 'Cash', date: '2026-09-05', receipt_no: 'R-1', notes: null },
]);

const balancesFixture = () => ([
  { id: 'sb-1', package_name: 'PT 10', total_sessions: 10, used_sessions: 3, remaining_sessions: 7, start_date: '2026-10-01', end_date: null },
  { id: 'sb-2', package_name: 'PT 5', total_sessions: 5, used_sessions: 5, remaining_sessions: 0, start_date: '2026-08-01', end_date: '2026-09-01' },
]);

const dietFixture = () => ({
  id: 'diet-1',
  start_date: '2026-11-01',
  end_date: null,
  status: 'active',
  template_name: 'Fat loss 1800',
  daily_calories: 1800,
  daily_protein_g: 140,
  daily_carbs_g: 170,
  daily_fats_g: 55,
});

const nutritionLogsFixture = () => ([
  { log_date: '2026-11-12', calories_consumed: 1750 },
  { log_date: '2026-11-11', calories_consumed: 1850 },
  { log_date: '2026-11-09', calories_consumed: 1700 },
  { log_date: '2026-11-08', calories_consumed: 0 },
]);

function buildFixture(overrides = {}) {
  return buildClient360({
    profile: profileFixture(),
    sources: sourcesFixture(),
    snapshot: snapshotFixture(),
    recovery: { present: true, score: 80, weeks: [] },
    brief: briefFixture(),
    attendance: attendanceFixture(),
    payments: paymentsFixture(),
    balances: balancesFixture(),
    diet: dietFixture(),
    nutritionLogs: nutritionLogsFixture(),
    subscription: { plan_name: 'PT Monthly', start_date: '2026-08-01', end_date: '2026-12-01', status: 'active' },
    today: TODAY,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
});

describe('buildClient360 aggregation', () => {
  it('assembles every dashboard section from the rows it is given', () => {
    const out = buildFixture();

    expect(out.client).toMatchObject({
      id: CLIENT, name: 'Hari Narayan Singh', age: 34, unique_id: 'PT-001',
      trainer_name: 'Ajeet', notes: 'Left knee — no deep lunges.', term_end: '2026-12-01',
    });
    expect(out.membership).toMatchObject({
      active: true, plan_name: 'PT Monthly', due_status: 'DUE',
      current_term_fee: 30000, current_term_paid: 25000, current_term_balance: 5000,
    });
    expect(out.assessment).toMatchObject({ present: true, as_of: '2026-11-01' });
    expect(out.assessment.capacity.overall).toBe(68);
    expect(out.training).toMatchObject({
      present: true, plan_name: 'Hypertrophy A', sessions_28d: 2, completed_28d: 1,
      adherence_pct: 50, last_session: { date: '2026-11-12', status: 'completed' },
    });
    expect(out.nutrition).toMatchObject({
      present: true, plan_name: 'Fat loss 1800', logged_days_7d: 3, avg_calories_7d: 1767,
      targets: { calories: 1800, protein_g: 140, carbs_g: 170, fats_g: 55 },
    });
    expect(out.attendance).toMatchObject({ last_30d: 2, last_90d: 3, sessions_remaining: 7 });
    expect(out.attendance.recent[0]).toMatchObject({ id: 'att-3', date: '2026-11-10', status: 'present' });
    expect(out.goals.primary.pct).toBe(30);
    expect(out.finance).toMatchObject({ outstanding: 5000, due_status: 'DUE' });
    expect(out.insights[0].id).toBe('on_track');
    expect(out.alerts[0].id).toBe('pending_payment');
    expect(out.completeness).toMatchObject({ pct: 100, missing: [], stale: [] });
  });

  it('derives the KPIs from the same rows as the detail sections', () => {
    const out = buildFixture();

    expect(out.kpis).toMatchObject({
      weight_kg: 82,
      weight_change_kg: -3,
      weight_change_since: '2026-09-01',
      body_fat_pct: 22.5,
      bmi: 26.1,
      sessions_remaining: 7,
      attendance_30d: 2,
      workout_adherence_pct: 50,
      nutrition_adherence_pct: 43,
      outstanding_balance: 5000,
    });
    expect(out.kpis.sessions_remaining).toBe(out.attendance.sessions_remaining);
    expect(out.kpis.outstanding_balance).toBe(out.finance.outstanding);
    expect(out.kpis.workout_adherence_pct).toBe(out.training.adherence_pct);
    expect(out.kpis.nutrition_adherence_pct).toBe(out.nutrition.adherence_pct);
  });

  it('orders the activity timeline newest first and bounds it', () => {
    const out = buildFixture();

    expect(out.timeline.length).toBeLessThanOrEqual(20);
    expect(out.timeline[0]).toMatchObject({ kind: 'workout', at: '2026-11-12' });
    const dates = out.timeline.map((e) => e.at);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(out.timeline.some((e) => e.kind === 'payment')).toBe(true);
    expect(out.timeline.some((e) => e.kind === 'nutrition')).toBe(true);
  });
});

describe('buildClient360 missing data', () => {
  const emptyBrief = () => ({
    client: { id: CLIENT, name: 'New Client', age: null, gender: null, notes: null, goal: null },
    sections: {
      readiness: { present: false },
      body: { present: false },
      capacity: { present: false },
      limitations: { present: false },
      lifestyle: { present: false },
      goal: { present: false },
      history: { present: false },
    },
    missing: ['readiness', 'body', 'capacity', 'limitations', 'lifestyle', 'goal', 'history'],
    stale: [],
    completeness_pct: 0,
  });

  it('returns nulls and present:false instead of inventing zeros', () => {
    const out = buildClient360({
      profile: profileFixture({ weight: null, body_fat: null, current_term_balance: null, balance_amount: null }),
      sources: sourcesFixture({ assessments: [], measurements: [], sessions: [], lastSession: null, checkins: [] }),
      snapshot: { alerts: [], goal: { present: false }, prs: [], coach: [], baseline_done: false },
      recovery: { present: false, weeks: [] },
      brief: emptyBrief(),
      attendance: [],
      payments: [],
      balances: [],
      diet: null,
      nutritionLogs: [],
      today: TODAY,
    });

    expect(out.assessment.present).toBe(false);
    expect(out.training.present).toBe(false);
    expect(out.nutrition.present).toBe(false);
    expect(out.kpis.weight_kg).toBeNull();
    expect(out.kpis.weight_change_kg).toBeNull();
    expect(out.kpis.body_fat_pct).toBeNull();
    expect(out.kpis.sessions_remaining).toBeNull();
    expect(out.kpis.workout_adherence_pct).toBeNull();
    expect(out.kpis.nutrition_adherence_pct).toBeNull();
    expect(out.attendance.last_30d).toBe(0);
    expect(out.attendance.recent).toEqual([]);
    expect(out.timeline).toEqual([]);
    expect(out.finance.outstanding).toBeNull();
    expect(out.goals.primary.present).toBe(false);
    expect(out.completeness.pct).toBe(0);
  });

  it('does not count a zero-calorie log as an adhered day', () => {
    const out = buildFixture({ nutritionLogs: [{ log_date: '2026-11-12', calories_consumed: 0 }] });
    expect(out.nutrition.logged_days_7d).toBe(0);
    expect(out.nutrition.avg_calories_7d).toBeNull();
    expect(out.nutrition.adherence_pct).toBe(0);
  });
});

describe('session balance accuracy', () => {
  it('sums the generated remaining_sessions column, never recomputes it', () => {
    const out = buildFixture({
      balances: [
        { id: 'a', total_sessions: 10, used_sessions: 3, remaining_sessions: 7 },
        { id: 'b', total_sessions: 5, used_sessions: 5, remaining_sessions: 0 },
      ],
    });
    expect(out.attendance.sessions_remaining).toBe(7);
    expect(out.attendance.packages).toEqual([
      expect.objectContaining({ id: 'a', total_sessions: 10, used_sessions: 3, remaining_sessions: 7 }),
      expect.objectContaining({ id: 'b', remaining_sessions: 0 }),
    ]);
  });

  it('returns null when the client has no active package', () => {
    const out = buildFixture({ balances: [] });
    expect(out.attendance.sessions_remaining).toBeNull();
    expect(out.attendance.packages).toEqual([]);
  });
});

describe('getClient360 tenant gate', () => {
  it('returns null for a foreign client and never reads a child table', async () => {
    getClientProfile.mockResolvedValueOnce(null);

    const result = await getClient360(ORG, CLIENT);

    expect(result).toBeNull();
    expect(loadClientSources).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('binds the organization on every child read that carries one', async () => {
    getClientProfile.mockResolvedValueOnce(profileFixture());
    loadClientSources.mockResolvedValueOnce(sourcesFixture());
    buildSnapshot.mockReturnValueOnce(snapshotFixture());
    buildRecovery.mockReturnValueOnce({ present: false, weeks: [] });
    buildBrief.mockReturnValueOnce(briefFixture());

    const calls = [];
    pool.query.mockImplementation(async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('attendance_logs')) return { rows: attendanceFixture() };
      if (sql.includes('pt_payments')) return { rows: paymentsFixture() };
      if (sql.includes('session_balance')) return { rows: balancesFixture() };
      if (sql.includes('diet_assignments')) return { rows: [dietFixture()] };
      if (sql.includes('nutrition_logs')) return { rows: nutritionLogsFixture() };
      if (sql.includes('pt_client_subscriptions')) return { rows: [{ plan_name: 'PT Monthly' }] };
      return { rows: [] };
    });

    const out = await getClient360(ORG, CLIENT);

    expect(out.client.id).toBe(CLIENT);
    expect(loadClientSources).toHaveBeenCalledWith(CLIENT, ORG, expect.objectContaining({
      client: expect.objectContaining({ id: CLIENT }),
      training: true,
      snapshot: true,
      sessionDays: 28,
    }));

    const orgScoped = calls.filter((c) => c.sql.includes('organization_id = $2'));
    expect(orgScoped.length).toBeGreaterThanOrEqual(5);
    orgScoped.forEach((c) => expect(c.params[1]).toBe(ORG));

    // The subscription read has no organization column; it is reached only
    // after the org-scoped profile gate and binds the client id.
    const subs = calls.find((c) => c.sql.includes('pt_client_subscriptions'));
    expect(subs.params).toEqual([CLIENT]);
  });

  it('does not run the aggregation when the shared loader refuses the client', async () => {
    getClientProfile.mockResolvedValueOnce(profileFixture());
    loadClientSources.mockResolvedValueOnce(null);

    const result = await getClient360(ORG, CLIENT);

    expect(result).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
