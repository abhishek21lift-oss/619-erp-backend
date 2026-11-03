'use strict';
// The AI → database boundary. Materialise is forgiving; this is the check that
// runs first, so a malformed proposal cannot become a plan that quietly holds
// fewer days than it claims.

const { validateProposedPlan } = require('../modules/pt-os/workout-validation');

const plan = (o = {}) => ({
  name: 'Block',
  weeks: 8,
  days_per_week: 1,
  weekly_schedule: {
    Monday: { exercises: [{ name: 'Bench Press', sets: 4, reps: '8-10' }] },
  },
  ...o,
});

describe('validateProposedPlan', () => {
  it('accepts the shape the generator actually returns', () => {
    expect(validateProposedPlan(plan())).toEqual({ ok: true, errors: [] });
  });

  it('accepts zero-valued unused numeric fields', () => {
    // A model filling every schema key writes 0 for the ones it did not use.
    const out = validateProposedPlan(plan({
      weekly_schedule: {
        Monday: { exercises: [{ name: 'Bike', sets: 0, duration_seconds: 0, distance: 0 }] },
      },
    }));
    expect(out.ok).toBe(true);
  });

  it('rejects a plan with no training days', () => {
    const out = validateProposedPlan(plan({ weekly_schedule: {} }));
    expect(out.ok).toBe(false);
    expect(out.errors).toContainEqual({
      path: 'weekly_schedule',
      message: 'must name at least one training day',
    });
  });

  it('rejects a day with no exercises', () => {
    const out = validateProposedPlan(plan({ weekly_schedule: { Monday: { exercises: [] } } }));
    expect(out.ok).toBe(false);
    expect(out.errors[0].path).toBe('weekly_schedule.Monday.exercises');
  });

  it('names the exercise that has no name', () => {
    const out = validateProposedPlan(plan({
      weekly_schedule: { Monday: { exercises: [{ name: 'Bench Press' }, { sets: 3 }] } },
    }));
    expect(out.ok).toBe(false);
    expect(out.errors).toContainEqual({
      path: 'weekly_schedule.Monday.exercises[1].name',
      message: 'must name an exercise',
    });
  });

  it('rejects a progression that cannot be stored', () => {
    const out = validateProposedPlan(plan({ progression: { type: 'weight', amount: 0 } }));
    expect(out.ok).toBe(false);
    expect(out.errors).toContainEqual({
      path: 'progression.amount',
      message: 'must be a positive number when a progression type is set',
    });
  });

  it('rejects impossible week and day counts', () => {
    const out = validateProposedPlan(plan({ weeks: 0, days_per_week: 9 }));
    expect(out.errors.map((e) => e.path)).toEqual(['weeks', 'days_per_week']);
  });

  it('rejects a non-object', () => {
    expect(validateProposedPlan(null)).toEqual({
      ok: false,
      errors: [{ path: '', message: 'plan must be an object' }],
    });
  });
});
