'use strict';

// Tests for src/lib/ai/clientState.js — Phase 2A Canonical Client State.
//
// Tests cover:
//   1. Tenant isolation (parent-first authorization)
//   2. Missing data handling
//   3. Freshness classification
//   4. Fact type classification
//   5. Deterministic values preserved exactly
//   6. No sensitive fields leaking
//   7. Task-specific context projection
//   8. Edge cases

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));
jest.mock('../lib/tenant-db', () => ({
  tenantScope: jest.fn(() => ({ applyFilter: true, orgId: 'org-1' })),
}));

const pool = require('../db/pool');
const {
  buildClientState,
  coachingContext,
  progressContext,
  workoutContext,
  programmingContext,
  classifyFreshness,
  daysSince,
  ageFromDob,
  FACT,
} = require('../lib/ai/clientState');

// ── Mock data ────────────────────────────────────────────────────────────

const MOCK_CLIENT = {
  id: 'client-1', name: 'Priya Sharma', dob: '1992-05-10', gender: 'female',
  mobile: '9876543210', status: 'active', goal: 'weight_loss', notes: null,
  injuries: 'Left shoulder impingement', health_conditions: null,
  weight: 65, height: 160, frequency: '4',
  pt_start_date: '2026-06-01', pt_end_date: '2026-12-01',
  balance_amount: 0, workout_experience_level: 'intermediate',
  previous_trainer_experience: true, trainer_id: 'trainer-1',
  organization_id: 'org-1', created_at: '2026-06-01', updated_at: '2026-08-20',
};

const MOCK_GOALS = [{
  id: 'g1', goal_type: 'weight_loss', target_weight: 60, target_body_fat: null,
  target_date: '2026-12-01', priority_goal: 'weight_loss',
  goal_description: 'Lose 5kg', commitment_level: 'high',
  motivation_level: 'high', biggest_challenges: null,
  estimated_duration_weeks: 24, created_at: '2026-06-01',
}];

const MOCK_ASSESSMENT = {
  assessment_date: '2026-08-15', assessment_type: 'full',
  weight: 63.5, height_cm: 160, bmi: 24.8, body_fat_pct: 24.2,
  muscle_mass_pct: 42.1, lean_body_mass_kg: 48.1, fat_mass_kg: 15.4,
  chest_cm: 88, waist_cm: 72, hips_cm: 96, waist_hip_ratio: 0.75,
  bp_systolic: 118, bp_diastolic: 76, bp_category: 'Normal',
  resting_heart_rate: 68, vo2_max: 34.5, cardio_category: 'Average',
  cardio_score_computed: 60, strength_score_computed: 70,
  strength_exercise: 'Bench Press', endurance_score_computed: 55,
  endurance_category: 'Average', flexibility_category: 'Good',
  mobility_score_computed: 75, has_asymmetry: false,
  body_composition_score: 80, health_risk_score: 90, overall_fitness_score: 71,
};

const MOCK_LIFESTYLE = {
  assessment_date: '2026-08-10', activity_level: 'moderately_active',
  workout_experience_level: 'intermediate', years_of_experience: 3,
  sleep_duration_hours: 7, sleep_quality: 'good', stress_level: 'moderate',
  occupation_type: 'desk', recovery_risk: 'low', recovery_score: 72,
  lifestyle_score: 68, food_preferences: 'vegetarian',
};

const MOCK_CHECKIN = {
  week_start_date: '2026-08-18', weight: 63.2, mood: 'good',
  sleep_hours: 7.5, water_glasses: 8, stress_level: 4,
  energy_level: 7, soreness_level: 3, client_notes: 'Feeling strong this week',
};

const MOCK_PARQ = {
  assessment_date: '2026-06-01', risk_level: 'low', risk_message: null,
  workout_gate_status: 'cleared', parq_yes_count: 1,
  current_health: ['mild asthma'], past_history: [],
};

const MOCK_PR = {
  exercise_name: 'Bench Press', record_type: 'MAX_WEIGHT',
  value: 42.5, unit: 'kg', reps: 3, achieved_on: '2026-08-18',
};

// ── Query mock builder ───────────────────────────────────────────────────

/**
 * Default matchers for each query in buildClientState.
 * Each entry: { name, test(sql), rows }.
 * The `name` field allows overrides to target specific queries.
 */
function defaultMatchers() {
  return [
    { name: 'client', test: (s) => s.includes('FROM pt_clients') && s.includes('deleted_at IS NULL'), rows: [MOCK_CLIENT] },
    { name: 'goals', test: (s) => s.includes('FROM pt_goals') && s.includes('is_active=true'), rows: MOCK_GOALS },
    { name: 'assessment_detail', test: (s) => s.includes('FROM pt_assessments') && s.includes('LIMIT 1') && s.includes('bp_systolic'), rows: [MOCK_ASSESSMENT] },
    { name: 'assessment_history', test: (s) => s.includes('FROM pt_assessments') && s.includes('LIMIT 10'), rows: [MOCK_ASSESSMENT] },
    { name: 'checkins', test: (s) => s.includes('FROM weekly_checkins'), rows: [MOCK_CHECKIN] },
    { name: 'lifestyle', test: (s) => s.includes('FROM pt_lifestyle_assessments'), rows: [MOCK_LIFESTYLE] },
    { name: 'nutrition', test: (s) => s.includes('FROM pt_nutrition_assessments'), rows: [] },
    { name: 'plan_detail', test: (s) => s.includes('sessions_per_week') && s.includes('JOIN workout_plans'), rows: [] },
    { name: 'assignments', test: (s) => s.includes('assignment_id') && s.includes('workout_assignments'), rows: [] },
    { name: 'diet_assignments', test: (s) => s.includes('FROM diet_assignments'), rows: [] },
    { name: 'sessions', test: (s) => s.includes('FROM workout_sessions') && !s.includes('JOIN'), rows: [] },
    { name: 'sets', test: (s) => s.includes('FROM workout_sets') && s.includes('target_muscle'), rows: [] },
    { name: 'prs', test: (s) => s.includes('FROM personal_records'), rows: [MOCK_PR] },
    { name: 'landmarks', test: (s) => s.includes('FROM muscle_volume_landmarks'), rows: [] },
    { name: 'posture', test: (s) => s.includes('FROM pt_posture_assessments'), rows: [] },
    { name: 'mobility', test: (s) => s.includes('FROM pt_mobility_performance_assessments'), rows: [] },
    { name: 'parq', test: (s) => s.includes('FROM pt_parq_forms'), rows: [MOCK_PARQ] },
    { name: 'consent', test: (s) => s.includes('FROM pt_informed_consents'), rows: [{ status: 'completed', created_at: '2026-06-01' }] },
    { name: 'attendance', test: (s) => s.includes('FROM attendance_logs'), rows: [] },
    { name: 'measurements', test: (s) => s.includes('FROM pt_os_measurements'), rows: [] },
    { name: 'exercises', test: (s) => s.includes('FROM workout_exercises') && s.includes('day_of_week'), rows: [{ day_of_week: 1 }, { day_of_week: 3 }, { day_of_week: 5 }] },
    // Phase 2B: Memory queries
    { name: 'memory', test: (s) => s.includes('FROM ai_client_memory'), rows: [] },
    { name: 'episodes', test: (s) => s.includes('FROM ai_client_episodes'), rows: [] },
    { name: 'episode_counts', test: (s) => s.includes('GROUP BY episode_type') && s.includes('ai_client_episodes'), rows: [] },
  ];
}

/**
 * Set up pool.query mock. `overrides` is an object keyed by matcher NAME,
 * mapping to the rows that matcher should return.
 */
function mockQueries(overrides = {}) {
  const matchers = defaultMatchers();
  // Apply overrides by name
  for (const [name, rows] of Object.entries(overrides)) {
    const m = matchers.find((x) => x.name === name);
    if (m) m.rows = rows;
  }

  pool.query.mockImplementation((sql) => {
    for (const m of matchers) {
      if (m.test(sql)) return Promise.resolve({ rows: m.rows });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  pool.query.mockReset();
});

// ── Unit tests ───────────────────────────────────────────────────────────

describe('classifyFreshness', () => {
  const thresholds = { current: 14, recent: 30, stale: 90 };

  test('returns "never" for null/undefined', () => {
    expect(classifyFreshness(null, thresholds)).toBe('never');
    expect(classifyFreshness(undefined, thresholds)).toBe('never');
  });

  test('returns "current" for recent dates', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(classifyFreshness(today, thresholds)).toBe('current');
  });

  test('returns "recent" for dates 15-30 days ago', () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 20);
    expect(classifyFreshness(d.toISOString().slice(0, 10), thresholds)).toBe('recent');
  });

  test('returns "stale" for dates >30 days ago', () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 45);
    expect(classifyFreshness(d.toISOString().slice(0, 10), thresholds)).toBe('stale');
  });
});

describe('ageFromDob', () => {
  test('calculates correct age', () => {
    const dob = new Date();
    dob.setUTCFullYear(dob.getUTCFullYear() - 30);
    expect(ageFromDob(dob.toISOString().slice(0, 10))).toBe(30);
  });

  test('returns null for null', () => {
    expect(ageFromDob(null)).toBeNull();
  });
});

// ── Integration tests ────────────────────────────────────────────────────

describe('buildClientState', () => {
  test('returns null for null client_id', async () => {
    const result = await buildClientState(null, 'org-1');
    expect(result).toBeNull();
  });

  test('returns null for non-existent client', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const result = await buildClientState('ghost', 'org-1');
    expect(result).toBeNull();
    // Only the parent query should have run
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('returns null for cross-tenant client', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const result = await buildClientState('other-org-client', 'org-1');
    expect(result).toBeNull();
  });

  test('returns complete state for a valid client', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');

    expect(state).not.toBeNull();
    expect(state.identity.name).toBe('Priya Sharma');
    expect(state.identity.gender).toBe('female');
    expect(state.identity.age).toBeGreaterThanOrEqual(30);
    expect(state.identity.organization_id).toBe('org-1');
  });

  test('includes body measurements from latest assessment', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');

    expect(state.body.measurements.weight_kg).toBe(63.5);
    expect(state.body.measurements.body_fat_pct).toBe(24.2);
    expect(state.body.scores.overall_fitness).toBe(71);
    expect(state.body.freshness).toBeDefined();
  });

  test('includes goals', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');

    expect(state.goals.active).toHaveLength(1);
    expect(state.goals.primary.goal_type).toBe('weight_loss');
    expect(state.goals.primary.target_weight).toBe(60);
  });

  test('includes recovery from check-in', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');

    expect(state.recovery.latest).not.toBeNull();
    expect(state.recovery.latest.sleep_hours).toBe(7.5);
    expect(state.recovery.readiness).not.toBeNull();
    expect(state.recovery.readiness.score).toBeGreaterThanOrEqual(0);
    expect(state.recovery.readiness.score).toBeLessThanOrEqual(100);
  });

  test('includes personal records', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');

    expect(state.performance.personalRecords).toHaveLength(1);
    expect(state.performance.personalRecords[0].exercise).toBe('Bench Press');
    expect(state.performance.personalRecords[0].value).toBe(42.5);
  });

  test('includes medical clearance', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');

    expect(state.clearance.parq).not.toBeNull();
    expect(state.clearance.parq.gate_status).toBe('cleared');
    expect(state.clearance.consent.status).toBe('completed');
  });

  test('includes lifestyle data', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');

    expect(state.lifestyle.experience_level).toBe('intermediate');
    expect(state.lifestyle.sleep_hours).toBe(7);
  });

  test('handles missing assessment gracefully', async () => {
    mockQueries({
      assessment_detail: [],
      assessment_history: [],
    });
    const state = await buildClientState('client-1', 'org-1');

    expect(state.body.source).toBe('missing');
    expect(state.missing.sections).toContain('assessment');
  });

  test('handles missing lifestyle gracefully', async () => {
    mockQueries({ lifestyle: [] });
    const state = await buildClientState('client-1', 'org-1');

    expect(state.lifestyle.source).toBe('missing');
    expect(state.missing.sections).toContain('lifestyle');
  });

  test('handles missing check-in gracefully', async () => {
    mockQueries({ checkins: [] });
    const state = await buildClientState('client-1', 'org-1');

    expect(state.recovery.latest).toBeNull();
    expect(state.recovery.readiness).toBeNull();
    expect(state.missing.sections).toContain('checkins');
  });

  test('handles missing PAR-Q gracefully', async () => {
    mockQueries({ parq: [] });
    const state = await buildClientState('client-1', 'org-1');

    expect(state.clearance.parq).toBeNull();
    expect(state.missing.sections).toContain('medicalClearance');
    expect(state.missing.critical_gaps).toContain('No PAR-Q screening on file');
  });

  test('marks critical gaps correctly', async () => {
    mockQueries({
      parq: [],
      assessment_detail: [],
      lifestyle: [],
    });
    const state = await buildClientState('client-1', 'org-1');

    expect(state.missing.critical_gaps).toContain('No PAR-Q screening on file');
    expect(state.missing.critical_gaps).toContain('No fitness assessment completed');
    expect(state.missing.critical_gaps).toContain('No lifestyle assessment — recovery capacity unknown');
  });

  test('includes injuries from client record', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');

    expect(state.limitations.injuries).toBe('Left shoulder impingement');
  });

  test('never returns SELECT * columns', async () => {
    mockQueries();
    await buildClientState('client-1', 'org-1');

    // Check that the client query does not use SELECT *
    const clientQuery = pool.query.mock.calls.find(([sql]) => sql.includes('FROM pt_clients'));
    expect(clientQuery).toBeDefined();
    expect(clientQuery[0]).not.toMatch(/SELECT \*/);
  });
});

// ── Task-specific context tests ──────────────────────────────────────────

describe('coachingContext', () => {
  test('returns empty string for null state', () => {
    expect(coachingContext(null)).toBe('');
  });

  test('includes client name and age', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');
    const ctx = coachingContext(state);

    expect(ctx).toContain('Priya Sharma');
    expect(ctx).toContain('female');
  });

  test('includes goals', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');
    const ctx = coachingContext(state);

    expect(ctx).toContain('weight_loss');
  });

  test('lists missing data', async () => {
    mockQueries({ lifestyle: [], checkins: [] });
    const state = await buildClientState('client-1', 'org-1');
    const ctx = coachingContext(state);

    expect(ctx).toContain('NOT MEASURED');
  });
});

describe('progressContext', () => {
  test('includes current measurements', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');
    const ctx = progressContext(state);

    expect(ctx).toContain('63.5 kg');
    expect(ctx).toContain('24.2%');
  });

  test('includes adherence when available', async () => {
    // Need plan + assignment + session data for adherence calculation
    const matchers = [
      { test: (s) => s.includes('FROM pt_clients') && s.includes('deleted_at IS NULL'), rows: [MOCK_CLIENT] },
      { test: (s) => s.includes('FROM pt_goals'), rows: MOCK_GOALS },
      { test: (s) => s.includes('FROM pt_assessments') && s.includes('bp_systolic'), rows: [MOCK_ASSESSMENT] },
      { test: (s) => s.includes('FROM pt_assessments') && s.includes('LIMIT 10'), rows: [MOCK_ASSESSMENT] },
      { test: (s) => s.includes('FROM weekly_checkins'), rows: [MOCK_CHECKIN] },
      { test: (s) => s.includes('FROM pt_lifestyle_assessments'), rows: [MOCK_LIFESTYLE] },
      { test: (s) => s.includes('FROM pt_nutrition_assessments'), rows: [] },
      { test: (s) => s.includes('sessions_per_week') && s.includes('JOIN workout_plans'), rows: [{ id: 'plan-1', name: 'Strength Block', duration_weeks: 12, sessions_per_week: 4 }] },
      { test: (s) => s.includes('assignment_id') && s.includes('workout_assignments'), rows: [{ assignment_id: 'a1', workout_plan_id: 'plan-1', start_date: '2026-08-01', end_date: '2026-10-24', status: 'active', plan_name: 'Strength Block', duration_weeks: 12 }] },
      { test: (s) => s.includes('FROM diet_assignments'), rows: [] },
      { test: (s) => s.includes('FROM workout_sessions') && !s.includes('JOIN'), rows: [
        { session_date: '2026-08-04', status: 'completed', duration_seconds: 3600 },
        { session_date: '2026-08-06', status: 'completed', duration_seconds: 3600 },
        { session_date: '2026-08-08', status: 'completed', duration_seconds: 3600 },
      ] },
      { test: (s) => s.includes('FROM workout_sets'), rows: [] },
      { test: (s) => s.includes('FROM personal_records'), rows: [MOCK_PR] },
      { test: (s) => s.includes('FROM muscle_volume_landmarks'), rows: [] },
      { test: (s) => s.includes('FROM pt_posture_assessments'), rows: [] },
      { test: (s) => s.includes('FROM pt_mobility_performance_assessments'), rows: [] },
      { test: (s) => s.includes('FROM pt_parq_forms'), rows: [MOCK_PARQ] },
      { test: (s) => s.includes('FROM pt_informed_consents'), rows: [{ status: 'completed', created_at: '2026-06-01' }] },
      { test: (s) => s.includes('FROM attendance_logs'), rows: [] },
      { test: (s) => s.includes('FROM pt_os_measurements'), rows: [] },
      { test: (s) => s.includes('FROM workout_exercises') && s.includes('day_of_week'), rows: [{ day_of_week: 1 }, { day_of_week: 3 }, { day_of_week: 5 }] },
    ];
    pool.query.mockImplementation((sql) => {
      for (const m of matchers) {
        if (m.test(sql)) return Promise.resolve({ rows: m.rows });
      }
      return Promise.resolve({ rows: [] });
    });

    const state = await buildClientState('client-1', 'org-1');
    const ctx = progressContext(state);

    expect(ctx).toContain('ADHERENCE');
  });
});

describe('workoutContext', () => {
  test('includes injuries and limitations', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');
    const ctx = workoutContext(state);

    expect(ctx).toContain('Left shoulder impingement');
  });

  test('includes medical gate status', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');
    const ctx = workoutContext(state);

    expect(ctx).toContain('cleared');
  });
});

describe('programmingContext', () => {
  test('includes personal records', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');
    const ctx = programmingContext(state);

    expect(ctx).toContain('Bench Press');
    expect(ctx).toContain('42.5 kg');
  });

  test('includes critical gaps', async () => {
    mockQueries({ parq: [] });
    const state = await buildClientState('client-1', 'org-1');
    const ctx = programmingContext(state);

    expect(ctx).toContain('CRITICAL GAPS');
    expect(ctx).toContain('PAR-Q');
  });
});

// ── Fact classification tests ────────────────────────────────────────────

describe('fact classification', () => {
  test('all fact types are defined', () => {
    expect(FACT.MEASURED).toBe('measured');
    expect(FACT.CALCULATED).toBe('calculated');
    expect(FACT.REPORTED).toBe('reported');
    expect(FACT.INFERRED).toBe('inferred');
    expect(FACT.MISSING).toBe('missing');
    expect(FACT.STALE).toBe('stale');
  });

  test('body measurements are MEASURED', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');
    expect(state.body.source).toBe('measured');
  });

  test('recovery readiness is REPORTED (self-reported)', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');
    expect(state.recovery.readiness.source).toBe('reported');
  });

  test('adherence is CALCULATED', async () => {
    // Adherence requires plan + assignment data to compute
    const matchers = [
      { test: (s) => s.includes('FROM pt_clients') && s.includes('deleted_at IS NULL'), rows: [MOCK_CLIENT] },
      { test: (s) => s.includes('FROM pt_goals'), rows: MOCK_GOALS },
      { test: (s) => s.includes('FROM pt_assessments') && s.includes('bp_systolic'), rows: [MOCK_ASSESSMENT] },
      { test: (s) => s.includes('FROM pt_assessments') && s.includes('LIMIT 10'), rows: [MOCK_ASSESSMENT] },
      { test: (s) => s.includes('FROM weekly_checkins'), rows: [MOCK_CHECKIN] },
      { test: (s) => s.includes('FROM pt_lifestyle_assessments'), rows: [MOCK_LIFESTYLE] },
      { test: (s) => s.includes('FROM pt_nutrition_assessments'), rows: [] },
      { test: (s) => s.includes('sessions_per_week') && s.includes('JOIN workout_plans'), rows: [{ id: 'plan-1', duration_weeks: 12, sessions_per_week: 4 }] },
      { test: (s) => s.includes('assignment_id') && s.includes('workout_assignments'), rows: [{ assignment_id: 'a1', workout_plan_id: 'plan-1', start_date: '2026-08-01', end_date: '2026-10-24', status: 'active', plan_name: 'Strength Block', duration_weeks: 12 }] },
      { test: (s) => s.includes('FROM diet_assignments'), rows: [] },
      { test: (s) => s.includes('FROM workout_sessions') && !s.includes('JOIN'), rows: [
        { session_date: '2026-08-04', status: 'completed', duration_seconds: 3600 },
        { session_date: '2026-08-06', status: 'completed', duration_seconds: 3600 },
      ] },
      { test: (s) => s.includes('FROM workout_sets'), rows: [] },
      { test: (s) => s.includes('FROM personal_records'), rows: [] },
      { test: (s) => s.includes('FROM muscle_volume_landmarks'), rows: [] },
      { test: (s) => s.includes('FROM pt_posture_assessments'), rows: [] },
      { test: (s) => s.includes('FROM pt_mobility_performance_assessments'), rows: [] },
      { test: (s) => s.includes('FROM pt_parq_forms'), rows: [MOCK_PARQ] },
      { test: (s) => s.includes('FROM pt_informed_consents'), rows: [{ status: 'completed', created_at: '2026-06-01' }] },
      { test: (s) => s.includes('FROM attendance_logs'), rows: [] },
      { test: (s) => s.includes('FROM pt_os_measurements'), rows: [] },
      { test: (s) => s.includes('FROM workout_exercises') && s.includes('day_of_week'), rows: [{ day_of_week: 1 }, { day_of_week: 3 }, { day_of_week: 5 }] },
    ];
    pool.query.mockImplementation((sql) => {
      for (const m of matchers) {
        if (m.test(sql)) return Promise.resolve({ rows: m.rows });
      }
      return Promise.resolve({ rows: [] });
    });
    const state = await buildClientState('client-1', 'org-1');
    expect(state.performance.adherence).not.toBeNull();
    expect(state.performance.adherence.source).toBe('calculated');
  });

  test('weight trend is INFERRED', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');
    expect(state.measurements.trend).toBeDefined();
    expect(state.measurements.source).toBe('inferred');
  });
});

// ── Tenant isolation tests ───────────────────────────────────────────────

describe('tenant isolation', () => {
  test('passes organization_id to parent query', async () => {
    mockQueries();
    await buildClientState('client-1', 'org-1');

    const clientQuery = pool.query.mock.calls.find(([sql]) => sql.includes('FROM pt_clients'));
    expect(clientQuery[1]).toContain('org-1');
  });

  test('passes null organization_id for platform super admin', async () => {
    mockQueries();
    await buildClientState('client-1', null);

    const clientQuery = pool.query.mock.calls.find(([sql]) => sql.includes('FROM pt_clients'));
    expect(clientQuery[1]).toContain(null);
  });
});

// ── Memory integration tests (Phase 2B) ──────────────────────────────────

describe('buildClientState — memory integration', () => {
  test('includes memory projection in state', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');

    expect(state.memory).toBeDefined();
    expect(state.memory.semantic).toBeDefined();
    expect(Array.isArray(state.memory.semantic)).toBe(true);
    expect(state.memory.episodes).toBeDefined();
    expect(Array.isArray(state.memory.episodes)).toBe(true);
    expect(state.memory.freshness).toBeDefined();
  });

  test('memory is empty when no memories exist', async () => {
    mockQueries();
    const state = await buildClientState('client-1', 'org-1');

    // Default mock returns empty for memory queries
    expect(state.memory.semantic).toHaveLength(0);
    expect(state.memory.episodes).toHaveLength(0);
    expect(state.memory.freshness).toBe('empty');
  });

  test('memory contains semantic facts when present', async () => {
    mockQueries({
      memory: [
        { id: 'm1', category: 'preference', subcategory: 'exercise', fact: 'Prefers mornings', confidence: 1.0, source_type: 'trainer_confirmed', as_of: '2026-08-20', verified_at: new Date() },
        { id: 'm2', category: 'constraint', subcategory: null, fact: 'No overhead press', confidence: 0.95, source_type: 'assessment', as_of: '2026-08-15', verified_at: null },
      ],
    });
    const state = await buildClientState('client-1', 'org-1');

    expect(state.memory.semantic).toHaveLength(2);
    expect(state.memory.semantic[0].fact).toBe('Prefers mornings');
    expect(state.memory.semantic[0].category).toBe('preference');
    expect(state.memory.semantic[1].fact).toBe('No overhead press');
    expect(state.memory.freshness).toBe('has_data');
  });

  test('memory contains episodes when present', async () => {
    mockQueries({
      episodes: [
        { id: 'e1', episode_type: 'pr_achieved', title: 'Bench PR', detail: '80kg', week_number: 8, session_date: new Date('2026-08-18'), severity: 'significant', source_type: 'workout_log', created_at: new Date('2026-08-18') },
      ],
      episode_counts: [
        { episode_type: 'pr_achieved', count: 1 },
      ],
    });
    const state = await buildClientState('client-1', 'org-1');

    expect(state.memory.episodes).toHaveLength(1);
    expect(state.memory.episodes[0].type).toBe('pr_achieved');
    expect(state.memory.episodes[0].title).toBe('Bench PR');
  });

  test('coachingContext includes memory when present', async () => {
    mockQueries({
      memory: [
        { id: 'm1', category: 'preference', subcategory: 'exercise', fact: 'Prefers morning workouts', confidence: 1.0, source_type: 'trainer_confirmed', as_of: '2026-08-20', verified_at: new Date() },
      ],
      episodes: [
        { id: 'e1', episode_type: 'pr_achieved', title: 'New bench PR', detail: null, week_number: 8, session_date: new Date(), severity: 'significant', source_type: 'workout_log', created_at: new Date() },
      ],
      episode_counts: [{ episode_type: 'pr_achieved', count: 1 }],
    });
    const state = await buildClientState('client-1', 'org-1');
    const ctx = coachingContext(state);

    expect(ctx).toContain('KNOWN FACTS:');
    expect(ctx).toContain('Prefers morning workouts');
    expect(ctx).toContain('RECENT EVENTS:');
    expect(ctx).toContain('New bench PR');
  });

  test('programmingContext includes memory when present', async () => {
    mockQueries({
      memory: [
        { id: 'm1', category: 'preference', subcategory: 'exercise', fact: 'Prefers barbell over dumbbell', confidence: 1.0, source_type: 'trainer_confirmed', as_of: '2026-08-20', verified_at: new Date() },
        { id: 'm2', category: 'constraint', subcategory: null, fact: 'No overhead pressing due to shoulder', confidence: 0.95, source_type: 'assessment', as_of: '2026-08-15', verified_at: null },
      ],
    });
    const state = await buildClientState('client-1', 'org-1');
    const ctx = programmingContext(state);

    expect(ctx).toContain('KNOWN CLIENT FACTS:');
    expect(ctx).toContain('Prefers barbell over dumbbell');
    expect(ctx).toContain('No overhead pressing due to shoulder');
  });
});
