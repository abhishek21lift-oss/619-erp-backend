'use strict';
// The member's tools are the data-minimisation boundary: every projection here
// drops trainer-private fields (commission, trainer_notes, payment notes,
// PAR-Q answers) before the model ever sees them.
jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../modules/client-portal/client-portal.service', () => ({
  myWorkout: jest.fn(), myDiet: jest.fn(), myCheckins: jest.fn(),
  myMeasurements: jest.fn(), myForms: jest.fn(),
}));
jest.mock('../modules/client-portal/member-coach.service', () => ({ coachFor: jest.fn() }));
jest.mock('../modules/client-portal/client-booking.repository', () => ({ upcomingForClient: jest.fn() }));
jest.mock('../modules/member-ai/member-ai.read', () => ({
  profile: jest.fn(), attendance: jest.fn(), membership: jest.fn(), payments: jest.fn(),
}));

const portal = require('../modules/client-portal/client-portal.service');
const coach = require('../modules/client-portal/member-coach.service');
const booking = require('../modules/client-portal/client-booking.repository');
const read = require('../modules/member-ai/member-ai.read');
const { run } = require('../modules/member-ai/member-ai.tools');

const CTX = { clientId: 'c1', orgId: 'org1', userId: 'u1', today: '2026-11-25' };

beforeEach(() => jest.clearAllMocks());

describe('getMyProfile', () => {
  it('drops contact details and internal money fields', async () => {
    read.profile.mockResolvedValue({
      name: 'Asha', goal: 'fat loss', height: 160, weight: 62,
      package_type: 'PT', joining_date: '2026-01-05', status: 'active',
      email: 'a@x.com', mobile: '999', address: 'somewhere', trainer_commission: 500,
    });
    coach.coachFor.mockResolvedValue({ name: 'Ravi' });

    const res = await run('getMyProfile', CTX);
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({
      name: 'Asha', goal: 'fat loss', height_cm: 160, weight_kg: 62,
      package_type: 'PT', trainer_name: 'Ravi',
      joining_date: '2026-01-05', status: 'active',
    });
    expect(coach.coachFor).toHaveBeenCalledWith(
      expect.anything(), { clientId: 'c1', orgId: 'org1' },
    );
  });
});

describe('getMyWorkout', () => {
  it("returns today's and the next training day, without media or ids", async () => {
    portal.myWorkout.mockResolvedValue([{
      name: 'Hypertrophy', current_week: 2,
      days: [
        { day_of_week: 3, exercises: [{
          exercise_id: 'e1', name: 'Bench', sets: 4, reps: '8', rest_seconds: 90,
          target_weight: 60, rpe: 8, cues: 'Drive feet', video_url: 'x', alternatives: ['y'],
        }] },
        { day_of_week: 5, exercises: [{ name: 'Row', sets: 3, reps: '10', rest_seconds: 60 }] },
      ],
    }]);

    const res = await run('getMyWorkout', CTX);
    expect(res.data.plan).toBe('Hypertrophy');
    expect(res.data.today.exercises[0]).toEqual({
      name: 'Bench', sets: 4, reps: '8', rest_seconds: 90,
      target_weight: 60, rpe: 8, cues: 'Drive feet',
    });
    expect(res.data.today.exercises[0]).not.toHaveProperty('video_url');
    expect(res.data.next.day_of_week).toBe(5);
    expect(portal.myWorkout).toHaveBeenCalledWith('c1', 'org1');
  });

  it('returns plan null when nothing is assigned', async () => {
    portal.myWorkout.mockResolvedValue([]);
    await expect(run('getMyWorkout', CTX)).resolves.toMatchObject({
      ok: true, data: { plan: null },
    });
  });
});

describe('getMyDiet', () => {
  it("keeps today's meals and drops template ids", async () => {
    portal.myDiet.mockResolvedValue([{
      template_id: 't1', name: 'Cut', daily: { calories: 1800, protein_g: 140, carbs_g: 180, fats_g: 55 },
      meals: [
        { meal_id: 'm1', name: 'Breakfast', day_of_week: null, serve_time: '08:00',
          calories: 400, protein_g: 30, carbs_g: 40, fats_g: 12,
          foods: [{ name: 'Oats', quantity: 50, unit: 'g', grams: 50, calories: 190 }] },
        { meal_id: 'm2', name: 'Sunday treat', day_of_week: 7, calories: 900 },
      ],
    }]);

    const res = await run('getMyDiet', CTX);
    expect(res.data.meals).toHaveLength(1);
    expect(res.data.meals[0]).toEqual({
      name: 'Breakfast', serve_time: '08:00', calories: 400,
      protein_g: 30, carbs_g: 40, fats_g: 12,
      foods: [{ name: 'Oats', quantity: 50, unit: 'g' }],
    });
    expect(res.data).not.toHaveProperty('template_id');
  });
});

describe('getMyCheckins', () => {
  it('keeps the member readings and drops trainer notes', async () => {
    portal.myCheckins.mockResolvedValue({
      checkins: [{
        id: 'w1', week_start_date: '2026-11-23', weight: 61.4, mood: 'good',
        sleep_hours: 7, water_glasses: 8, stress_level: 4, energy_level: 7,
        soreness_level: 3, client_notes: 'felt strong', trainer_notes: 'private', adherence: 90,
      }],
    });

    const res = await run('getMyCheckins', CTX);
    expect(res.data.weeks[0]).toEqual({
      week_start_date: '2026-11-23', weight: 61.4, mood: 'good',
      sleep_hours: 7, water_glasses: 8, stress_level: 4, energy_level: 7,
      soreness_level: 3, client_notes: 'felt strong',
    });
    expect(res.data.weeks[0]).not.toHaveProperty('trainer_notes');
  });
});

describe('getMyMeasurements', () => {
  it('returns the latest reading and the change over the window', async () => {
    portal.myMeasurements.mockResolvedValue([
      { id: 'm1', weight_kg: 61, waist_cm: 78, body_fat_pct: 24, measured_at: '2026-11-20', source: 'trainer' },
      { id: 'm2', weight_kg: 64, waist_cm: 82, body_fat_pct: 27, measured_at: '2026-09-01', source: 'assessment' },
    ]);

    const res = await run('getMyMeasurements', CTX);
    expect(res.data.latest).toMatchObject({ weight_kg: 61, waist_cm: 78, body_fat_pct: 24 });
    expect(res.data.change).toEqual({ weight_kg: -3, waist_cm: -4, body_fat_pct: -3 });
    expect(res.data.entries[0]).not.toHaveProperty('id');
  });
});

describe('getMyAttendance', () => {
  it('counts present visits and reports the last one', async () => {
    read.attendance.mockResolvedValue([
      { date: '2026-11-24', status: 'present' },
      { date: '2026-11-22', status: 'present' },
      { date: '2026-11-10', status: 'absent' },
      { date: '2026-10-01', status: 'late' },
    ]);

    const res = await run('getMyAttendance', CTX);
    expect(res.data.last_visit).toBe('2026-11-24');
    expect(res.data.visits_last_7_days).toBe(2);
    expect(res.data.visits_last_30_days).toBe(2);
    expect(res.data.recent).toEqual(['2026-11-24', '2026-11-22', '2026-10-01']);
  });
});

describe('getMyMembership', () => {
  it('returns the member own money and no commission', async () => {
    read.membership.mockResolvedValue({
      package_type: 'PT', pt_start_date: '2026-06-01', pt_end_date: '2026-12-01',
      duration_months: 6, final_amount: 30000, paid_amount: 20000,
      balance_amount: 10000, status: 'active', trainer_commission: 3000,
    });

    const res = await run('getMyMembership', CTX);
    expect(res.data).toEqual({
      package_type: 'PT', pt_start_date: '2026-06-01', pt_end_date: '2026-12-01',
      duration_months: 6, final_amount: 30000, paid_amount: 20000,
      balance_amount: 10000, status: 'active', days_left: 6,
    });
    expect(res.data).not.toHaveProperty('trainer_commission');
  });
});

describe('getMyPayments', () => {
  it('drops internal payment notes', async () => {
    read.payments.mockResolvedValue([
      { date: '2026-11-01', amount: 10000, payment_method: 'upi', notes: 'internal' },
    ]);
    const res = await run('getMyPayments', CTX);
    expect(res.data.payments).toEqual([
      { date: '2026-11-01', amount: 10000, method: 'upi' },
    ]);
  });
});

describe('getMyBookings', () => {
  it('returns the next three sessions without ids', async () => {
    booking.upcomingForClient.mockResolvedValue([
      { id: 's1', session_date: '2026-11-26', start_time: '07:00', end_time: '08:00', duration_minutes: 60, status: 'scheduled' },
      { id: 's2', session_date: '2026-11-28', start_time: '07:00', end_time: '08:00', duration_minutes: 60, status: 'scheduled' },
      { id: 's3', session_date: '2026-11-30', start_time: '07:00', end_time: '08:00', duration_minutes: 60, status: 'scheduled' },
      { id: 's4', session_date: '2026-12-02', start_time: '07:00', end_time: '08:00', duration_minutes: 60, status: 'scheduled' },
    ]);

    const res = await run('getMyBookings', CTX);
    expect(res.data.sessions).toHaveLength(3);
    expect(res.data.sessions[0]).toEqual({
      date: '2026-11-26', start_time: '07:00', end_time: '08:00',
      duration_minutes: 60, status: 'scheduled',
    });
    expect(res.data.sessions[0]).not.toHaveProperty('id');
  });
});

describe('getMyForms', () => {
  it('returns status only, never PAR-Q answers', async () => {
    portal.myForms.mockResolvedValue({
      parq: { status: 'submitted', assessment_date: '2026-10-01', risk_level: 'low',
              risk_message: 'clear', parq_answers: { q1: 'yes' }, current_health: 'x' },
      consent: { status: 'completed', completed_at: '2026-10-01', client_signed_at: 'x' },
    });

    const res = await run('getMyForms', CTX);
    expect(res.data).toEqual({
      parq: { status: 'submitted', assessment_date: '2026-10-01', risk_level: 'low' },
      consent: { status: 'completed', completed_at: '2026-10-01' },
    });
    expect(JSON.stringify(res.data)).not.toContain('parq_answers');
  });
});

describe('tool failure', () => {
  it('returns a typed failure instead of throwing', async () => {
    read.profile.mockRejectedValue(new Error('db down'));
    await expect(run('getMyProfile', CTX)).resolves.toEqual({
      ok: false, tool: 'getMyProfile', message: 'Could not read this right now.',
    });
  });

  it('refuses an unknown tool', async () => {
    await expect(run('dropTables', CTX)).resolves.toMatchObject({ ok: false, tool: 'dropTables' });
  });
});
