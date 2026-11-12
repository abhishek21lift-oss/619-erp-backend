'use strict';
// The eleven Phase 3 read tools: what they return, what they refuse, and what
// they deliberately leave out.
//
// The services are mocked; the registry, Phase 2 attendance summary, progression
// resolver and training-history builder are real, so the shaping and the
// missing-data behaviour are exercised end to end rather than restated.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../modules/pt-os/pt-os.service', () => ({
  getTrainerSchedule: jest.fn(),
  getTrainerWorkload: jest.fn(),
  getBalanceSheet: jest.fn(),
}));
jest.mock('../modules/pt-os/client-read.service', () => ({
  findVisibleClient: jest.fn(),
  getClientProfile: jest.fn(),
  getClientSnapshot: jest.fn(),
  getClientTrainingBrief: jest.fn(),
  getClientAttendance: jest.fn(),
}));
jest.mock('../modules/pt-os/authoritative-client', () => ({ loadClientSources: jest.fn() }));
jest.mock('../modules/pt-os/churn.service', () => ({ buildChurnList: jest.fn() }));
jest.mock('../modules/client-portal/member-goals.service', () => ({ goalsForStudio: jest.fn() }));
jest.mock('../modules/copilot/context/client-scope', () => ({
  resolveSelectedClient: jest.fn(),
}));

const pool = require('../db/pool');
const svc = require('../modules/pt-os/pt-os.service');
const clientRead = require('../modules/pt-os/client-read.service');
const { loadClientSources } = require('../modules/pt-os/authoritative-client');
const { buildChurnList } = require('../modules/pt-os/churn.service');
const memberGoals = require('../modules/client-portal/member-goals.service');
const { resolveSelectedClient } = require('../modules/copilot/context/client-scope');
const { createRegistry } = require('../modules/copilot/tools/registry');
const { TOOLS } = require('../modules/copilot/tools/read-tools');
const { today: studioToday } = require('../lib/appTime');

const ORG = '11111111-1111-1111-1111-111111111111';
const CLIENT = 'client-1';
const req = { user: { id: 'usr-1', role: 'trainer', trainer_id: 'tr-1', organization_id: ORG } };

const registry = createRegistry(TOOLS);
const run = (name, args = {}, clientId = CLIENT) => registry.run(req, name, args, { clientId });

const CATALOG = [
  'get_active_workout_program',
  'get_attendance_summary',
  'get_client_assessments',
  'get_client_goals',
  'get_client_profile',
  'get_client_progress',
  'get_membership_alerts',
  'get_pending_followups',
  'get_trainer_schedule',
  'get_trainer_workload',
  'get_workout_history',
];

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

beforeEach(() => {
  jest.clearAllMocks();
  resolveSelectedClient.mockImplementation(async (_ctx, id) => (id ? { id, name: 'Asha' } : null));
});

describe('catalog parity', () => {
  test('registers exactly the eleven read tools', () => {
    expect(registry.list().map((t) => t.name).sort()).toEqual(CATALOG);
  });

  test('every registered tool is READ-only and declares its scope, sensitivity and timeout', () => {
    for (const tool of registry.list()) {
      expect(tool.level).toBe('READ');
      expect(['none', 'required']).toContain(tool.clientScope);
      expect(['public', 'business', 'schedule', 'personal', 'clinical']).toContain(tool.sensitivity);
      expect(tool.timeoutMs).toBeGreaterThan(0);
      expect(tool.source).toBeTruthy();
    }
  });
});

/* ── 1/2. Schedule and workload ─────────────────────────────────────────── */

describe('get_trainer_schedule', () => {
  test('defaults to the next seven days and never returns the client mobile', async () => {
    svc.getTrainerSchedule.mockResolvedValueOnce([{
      id: 's1', session_date: new Date(2026, 10, 12), start_time: '07:00:00',
      end_time: '08:00:00', title: 'PT Session', status: 'scheduled',
      client_name: 'Asha', client_mobile: '9876543210', plan_name: 'Hypertrophy',
    }]);

    const out = await run('get_trainer_schedule');

    expect(out.ok).toBe(true);
    expect(out.data.from).toBe(studioToday());
    expect(out.data.sessions[0]).toEqual({
      id: 's1', date: '2026-11-12', start: '07:00:00', end: '08:00:00',
      title: 'PT Session', status: 'scheduled', client_name: 'Asha', plan_name: 'Hypertrophy',
    });
    expect(JSON.stringify(out)).not.toContain('9876543210');
    expect(svc.getTrainerSchedule).toHaveBeenCalledWith(ORG, {
      from: studioToday(), to: out.data.to, limit: 50,
    });
  });

  test('rejects a window longer than 31 days before any read', async () => {
    const out = await run('get_trainer_schedule', { from: '2026-01-01', to: '2026-03-01' });

    expect(out).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(svc.getTrainerSchedule).not.toHaveBeenCalled();
  });

  test('an empty window is reported as missing, not as "no sessions exist"', async () => {
    svc.getTrainerSchedule.mockResolvedValueOnce([]);

    const out = await run('get_trainer_schedule', { from: '2026-11-11', to: '2026-11-18' });

    expect(out.ok).toBe(true);
    expect(out.data.sessions).toEqual([]);
    expect(out.provenance.missing).toContain('no sessions in the requested window');
  });
});

describe('get_trainer_workload', () => {
  test('returns per-trainer rows and honest totals', async () => {
    svc.getTrainerWorkload.mockResolvedValueOnce([
      { trainer_name: 'Trainer One', completed: 12, scheduled: 3, missed: 1 },
      { trainer_name: 'Unassigned', completed: 2, scheduled: 0, missed: 0 },
    ]);

    const out = await run('get_trainer_workload');

    expect(out.data.totals).toEqual({ completed: 14, scheduled: 3, missed: 1 });
    expect(out.data.trainers).toHaveLength(2);
    expect(out.data.month).toBe(studioToday().slice(0, 7));
  });
});

/* ── 3. Profile ─────────────────────────────────────────────────────────── */

describe('get_client_profile', () => {
  const profile = {
    id: CLIENT, name: 'Asha', status: 'active', gender: 'female', dob: '1995-04-10',
    goal: 'fat loss', package_type: 'PT', weight: '64.20',
    pt_start_date: '2026-01-10', pt_end_date: '2026-12-10', days_left: 29,
    duration_months: 12, current_term_balance: '1500.00', due_status: 'DUE',
    trainer_name: 'Trainer One', mobile: '9876543210', email: 'asha@example.com',
    address: '12 Market Road', emergency_contact: '9999999999',
    notes: 'private trainer note', updated_at: new Date(2026, 10, 10),
    screening: {
      consent: { status: 'completed' },
      parq: { status: 'submitted', risk_level: 'low' },
      complete: true, block: null, missing: [],
    },
  };

  test('returns the coach facts and reports contact on file without exposing it', async () => {
    clientRead.getClientProfile.mockResolvedValueOnce(profile);

    const out = await run('get_client_profile');
    const text = JSON.stringify(out);

    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({
      id: CLIENT, name: 'Asha', age: expect.any(Number), goal: 'fat loss',
      current_term_balance: 1500, due_status: 'DUE',
      contact_on_file: { mobile: true, email: true, address: true, emergency_contact: true },
      screening: { consent_status: 'completed', parq_status: 'submitted', risk_level: 'low' },
    });
    for (const secret of ['9876543210', 'asha@example.com', '12 Market Road', '9999999999', 'private trainer note']) {
      expect(text).not.toContain(secret);
    }
  });

  test('names an absent goal, weight and term instead of defaulting them', async () => {
    clientRead.getClientProfile.mockResolvedValueOnce({
      ...profile, goal: null, weight: null, pt_end_date: null, days_left: null, mobile: null, email: null,
    });

    const out = await run('get_client_profile');

    expect(out.data.goal).toBeNull();
    expect(out.data.weight_kg).toBeNull();
    expect(out.data.pt_end_date).toBeNull();
    expect(out.provenance.missing).toEqual(
      expect.arrayContaining(['goal', 'weight', 'pt_end_date', 'contact'])
    );
  });
});

/* ── 4. Goals ───────────────────────────────────────────────────────────── */

describe('get_client_goals', () => {
  test('returns member goals, the trainer goal and the client goal field', async () => {
    memberGoals.goalsForStudio.mockResolvedValueOnce({
      studio: {
        id: 'g0', goal_type: 'weight_loss', priority_goal: 'lose fat',
        target_weight: 60, target_date: '2026-12-01', start_value: 70,
        current_value: 66, progress_pct: 40, created_at: '2026-02-01',
      },
      goals: [{
        id: 'mg1', kind: 'weight', exercise_name: null, start_value: 70, target_value: 60,
        current_value: 66, target_date: '2026-12-01', created_at: '2026-03-01',
        achieved_at: null, reached: false, progress_pct: 40,
        projection: { eta: null, reason: 'off_trend', per_week: 0 }, status: 'behind',
      }],
    });
    loadClientSources.mockResolvedValueOnce({
      client: { id: CLIENT, goal: 'fat loss' },
      goals: [{
        id: 'g0', goal_type: 'weight_loss', priority_goal: 'lose fat',
        target_weight: 60, target_body_fat: null, target_date: '2026-12-01',
        starting_weight: 70, created_at: '2026-02-01', goal_description: 'free text',
      }],
    });

    const out = await run('get_client_goals');

    expect(out.data.client_goal).toBe('fat loss');
    expect(out.data.member_goals[0]).toMatchObject({ id: 'mg1', kind: 'weight', progress_pct: 40 });
    expect(out.data.trainer_goal).toMatchObject({ id: 'g0', progress_pct: 40 });
    expect(out.data.active_trainer_goals[0]).toMatchObject({ id: 'g0', target_weight: 60 });
    expect(JSON.stringify(out)).not.toContain('free text');
  });

  test('says when there is no goal at all', async () => {
    memberGoals.goalsForStudio.mockResolvedValueOnce({ studio: null, goals: [] });
    loadClientSources.mockResolvedValueOnce({ client: { id: CLIENT, goal: null }, goals: [] });

    const out = await run('get_client_goals');

    expect(out.data.member_goals).toEqual([]);
    expect(out.provenance.missing).toEqual(
      expect.arrayContaining(['no member goals recorded', 'no active trainer goal'])
    );
  });
});

/* ── 5. Assessments ─────────────────────────────────────────────────────── */

describe('get_client_assessments', () => {
  test('keeps structured findings, strips free-text notes and filters missing/stale to the returned sections', async () => {
    clientRead.getClientTrainingBrief.mockResolvedValueOnce({
      client: { id: CLIENT, name: 'Asha' },
      sections: {
        readiness: {
          present: true, as_of: '2026-10-01', risk_level: 'low', gate_status: 'cleared',
          notes: 'trainer note', trainer_notes: 'another note',
        },
        body: { present: true, as_of: '2026-10-01', weight_kg: 64.2, bmi: 22.1 },
        capacity: { present: true, as_of: '2026-10-01', overall: 72 },
        limitations: {
          present: true,
          posture: { as_of: '2026-09-01', issues: ['forward head'], notes: 'coach note' },
          mobility: { findings: [{ region: 'hip', status: 'restricted' }], performance_notes: 'mobility note' },
          injuries: 'old knee injury',
        },
        lifestyle: { present: true, notes: 'lifestyle note' },
        goal: { present: false },
        history: { present: false },
      },
      missing: ['goal', 'history'],
      stale: [{ section: 'body', as_of: '2026-10-01' }],
      completeness_pct: 40,
    });

    const out = await run('get_client_assessments');
    const text = JSON.stringify(out);

    expect(out.data.sections.body).toMatchObject({ weight_kg: 64.2, bmi: 22.1 });
    expect(out.data.sections.limitations.injuries).toBe('old knee injury');
    expect(out.data.sections.limitations.posture.issues).toEqual(['forward head']);
    expect(out.data.sections.lifestyle).toBeUndefined();
    expect(out.data.missing).toEqual([]);
    expect(out.data.stale).toEqual([{ section: 'body', as_of: '2026-10-01' }]);
    for (const note of ['trainer note', 'another note', 'coach note', 'mobility note', 'lifestyle note']) {
      expect(text).not.toContain(note);
    }
  });

  test('reports which assessments are missing when the brief has none', async () => {
    clientRead.getClientTrainingBrief.mockResolvedValueOnce({
      client: { id: CLIENT, name: 'Asha' },
      sections: { readiness: { present: false }, body: { present: false }, capacity: { present: false }, limitations: { present: false } },
      missing: ['readiness', 'body', 'capacity', 'limitations'],
      stale: [],
    });

    const out = await run('get_client_assessments');

    expect(out.data.missing).toHaveLength(4);
    expect(out.data.completeness_pct).toBe(0);
    expect(out.provenance.missing).toContain('no body assessment on file');
  });
});

/* ── 6. Progress ────────────────────────────────────────────────────────── */

describe('get_client_progress', () => {
  test('separates measured facts from derived coach prompts', async () => {
    clientRead.getClientSnapshot.mockResolvedValueOnce({
      alerts: [{ id: 'pt_expiring', severity: 'warning' }],
      goal: { present: true, target_kg: 60, current_kg: 64, pct: 40 },
      prs: [{ exercise: 'Squat', weight_kg: 80, reps: 5, achieved_on: '2026-10-20' }],
      coach: [{ id: 'recovery', tone: 'warn', text: 'Trim accessory volume.' }],
      baseline_done: true,
      recovery: { score: 70 },
    });

    const out = await run('get_client_progress');

    expect(out.data.facts.prs[0].exercise).toBe('Squat');
    expect(out.data.facts.alerts).toHaveLength(1);
    expect(out.data.inferred.coach[0].id).toBe('recovery');
    expect(out.provenance.as_of).toBe('2026-10-20');
  });

  test('marks a missing baseline instead of showing zero progress', async () => {
    clientRead.getClientSnapshot.mockResolvedValueOnce({
      alerts: [], goal: { present: false }, prs: [], coach: [], baseline_done: false, recovery: {},
    });

    const out = await run('get_client_progress');

    expect(out.data.facts.baseline_done).toBe(false);
    expect(out.provenance.missing).toEqual(
      expect.arrayContaining(['no baseline measurements or goal', 'no personal records logged'])
    );
  });
});

/* ── 7. Workout history ─────────────────────────────────────────────────── */

describe('get_workout_history', () => {
  const squat = (kg, date) => ({
    exercise_name: 'Squat', weight_kg: kg, reps: 5, completed: true, session_date: date,
  });

  test('builds a bounded history from completed sets only and drops the per-session series', async () => {
    loadClientSources.mockResolvedValueOnce({
      assignment: null,
      sessions: [],
      sets: [
        squat(80, '2026-10-01'), squat(82.5, '2026-10-08'), squat(85, '2026-10-15'),
        { exercise_name: 'Bench', weight_kg: 60, reps: 8, completed: false, session_date: '2026-10-15' },
      ],
    });

    const out = await run('get_workout_history', { window_weeks: 8 });

    expect(out.data.window_weeks).toBe(8);
    expect(out.data.has_history).toBe(true);
    expect(out.data.totals.sets).toBe(3);
    expect(out.data.exercises[0].points).toBeUndefined();
    expect(out.provenance.as_of).toBe('2026-10-15');
    expect(loadClientSources).toHaveBeenCalledWith(CLIENT, ORG, expect.objectContaining({
      sets: true, windowWeeks: 8,
    }));
  });

  test('no logged sets is "not logged", not a beginner and not a zero', async () => {
    loadClientSources.mockResolvedValueOnce({ assignment: null, sessions: [], sets: [] });

    const out = await run('get_workout_history');

    expect(out.data.has_history).toBe(false);
    expect(out.provenance.missing).toContain('no completed sets logged in the window');
  });

  test('rejects a window outside 1..24 weeks before any read', async () => {
    const out = await run('get_workout_history', { window_weeks: 52 });

    expect(out).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(loadClientSources).not.toHaveBeenCalled();
  });
});

/* ── 8. Active programme ────────────────────────────────────────────────── */

describe('get_active_workout_program', () => {
  const today = studioToday();

  test('returns the current week and the prescribed exercises without notes', async () => {
    loadClientSources.mockResolvedValueOnce({
      assignment: {
        plan_id: 'plan-1', plan_name: 'Hypertrophy', start_date: today,
        duration_weeks: 8, planned_days_count: 2, progress_pct: 25,
      },
      sessions: [],
    });
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'plan-1', name: 'Hypertrophy', duration_weeks: 8,
          progression_type: 'none', progression_amount: null, progression_every_weeks: 1,
          periodization_model: null, block_phases: null,
          deload_every_weeks: null, deload_intensity_pct: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            day_of_week: 1, week_number: 1, exercise_id: 'e1', exercise_name: 'Squat',
            sets: 4, reps: 5, target_weight: '80.00', rpe: null, sort_order: 1,
          },
          {
            day_of_week: 3, week_number: 1, exercise_id: 'e2', exercise_name: 'Bench',
            sets: 4, reps: 8, target_weight: '60.00', rpe: 8, sort_order: 1,
          },
        ],
      });

    const out = await run('get_active_workout_program');

    expect(out.data.active).toBe(true);
    expect(out.data.current_week).toBe(1);
    expect(out.data.plan_name).toBe('Hypertrophy');
    expect(out.data.days).toHaveLength(2);
    expect(out.data.days[0]).toMatchObject({ day: 'Monday', source: 'derived' });
    expect(out.data.days[0].exercises[0]).toEqual({
      name: 'Squat', sets: 4, reps: 5, target_weight: 80, rpe: null,
    });
    // The current week bounds the prescription read.
    expect(pool.query.mock.calls[1][1]).toEqual(['plan-1', 1]);
  });

  test('no assignment is reported as no active programme', async () => {
    loadClientSources.mockResolvedValueOnce({ assignment: null, sessions: [] });

    const out = await run('get_active_workout_program');

    expect(out.data).toEqual({ active: false });
    expect(out.provenance.missing).toContain('no active workout program');
    expect(pool.query).not.toHaveBeenCalled();
  });
});

/* ── 9. Attendance ──────────────────────────────────────────────────────── */

describe('get_attendance_summary', () => {
  test('counts check-ins inside the requested window and keeps the last attended date', async () => {
    clientRead.getClientAttendance.mockResolvedValueOnce([
      { id: 'a1', date: daysAgo(1), status: 'present' },
      { id: 'a2', date: daysAgo(5), status: 'absent' },
      { id: 'a3', date: daysAgo(40), status: 'present' },
    ]);

    const out = await run('get_attendance_summary', { days: 28 });

    expect(out.data.window_days).toBe(28);
    expect(out.data.present).toBe(1);
    expect(out.data.absent).toBe(1);
    expect(out.data.last_present_on).toBe(daysAgo(1));
    expect(out.provenance.as_of).toBe(daysAgo(1));
  });

  test('an empty history says so rather than reporting a clean 0%', async () => {
    clientRead.getClientAttendance.mockResolvedValueOnce([]);

    const out = await run('get_attendance_summary');

    expect(out.data.present).toBe(0);
    expect(out.provenance.missing).toEqual(
      expect.arrayContaining(['no present check-ins in the window', 'no attendance ever recorded'])
    );
  });
});

/* ── 10. Follow-ups ─────────────────────────────────────────────────────── */

describe('get_pending_followups', () => {
  test('returns churn rows and due leads with no contact data', async () => {
    buildChurnList.mockResolvedValueOnce({
      as_of: studioToday(),
      assessed: 10,
      flagged: 1,
      bands: { critical: 0, high: 1, medium: 0, low: 0 },
      rows: [{
        client_id: CLIENT, client_name: 'Asha', score: 55, band: 'high',
        reasons: [{ code: 'silent_21', label: 'Last trained 41 days ago' }],
        next_action: 'Call today', last_session: '2026-10-01', days_quiet: 41,
        term: { state: 'active', days_left: 20 }, balance_amount: 0, risk_increased: false,
      }],
    });
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'lead-1', name: 'Ravi', status: 'new', source: 'walk_in',
        interested_package: 'PT', follow_up_date: '2026-11-10',
        trainer_name: 'Trainer One', mobile: '9999999999',
      }],
    });

    const out = await run('get_pending_followups', { limit: 10 });

    expect(out.data.churn[0]).toMatchObject({ client_id: CLIENT, band: 'high', score: 55 });
    expect(out.data.leads[0]).toMatchObject({ id: 'lead-1', follow_up_date: '2026-11-10' });
    expect(JSON.stringify(out)).not.toContain('9999999999');
    // The lead read is org-scoped and bounded.
    expect(pool.query.mock.calls[0][1]).toEqual([ORG, 10]);
    expect(String(pool.query.mock.calls[0][0])).toMatch(/organization_id = \$1/);
  });

  test('says when there is nothing to follow up', async () => {
    buildChurnList.mockResolvedValueOnce({
      as_of: studioToday(), assessed: 0, flagged: 0,
      bands: { critical: 0, high: 0, medium: 0, low: 0 }, rows: [],
    });
    pool.query.mockResolvedValueOnce({ rows: [] });

    const out = await run('get_pending_followups');

    expect(out.provenance.missing).toEqual(
      expect.arrayContaining(['no clients above the churn-risk threshold', 'no leads with a follow-up due'])
    );
  });
});

/* ── 11. Membership alerts ──────────────────────────────────────────────── */

describe('get_membership_alerts', () => {
  test('orders ended, ending and unpaid alerts by urgency and caps them', async () => {
    svc.getBalanceSheet.mockResolvedValueOnce([
      {
        id: 'c1', name: 'Asha', status: 'active', package_type: 'PT',
        pt_end_date: daysAgo(-4), days_left: 4, balance_amount: '1500.00',
      },
      {
        id: 'c2', name: 'Bala', status: 'active', package_type: 'PT',
        pt_end_date: daysAgo(41), days_left: -41, balance_amount: '0',
      },
      {
        id: 'c3', name: 'Cara', status: 'expired', package_type: 'PT',
        pt_end_date: null, days_left: null, balance_amount: '500.00', mobile: '9876543210',
      },
    ]);

    const out = await run('get_membership_alerts', { days: 14 });

    expect(out.data.checked).toBe(3);
    expect(out.data.alerts.map((a) => a.type)).toEqual([
      'term_ended', 'term_expiring', 'outstanding_balance', 'outstanding_balance',
    ]);
    expect(out.data.alerts[1]).toMatchObject({ client_id: 'c1', balance_amount: 1500 });
    expect(JSON.stringify(out)).not.toContain('9876543210');
  });

  test('no alerts is stated as none found', async () => {
    svc.getBalanceSheet.mockResolvedValueOnce([]);

    const out = await run('get_membership_alerts');

    expect(out.data.alerts).toEqual([]);
    expect(out.provenance.missing).toContain('no expiring terms or outstanding balances');
  });
});
