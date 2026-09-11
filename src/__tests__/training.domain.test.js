// The training domain's arithmetic, tested without a database.
//
// Everything in modules/training is a pure function, which is the point of
// putting it there: a progression rule that adds weight to a session the
// client never finished is a coaching bug, and it should be catchable without
// standing up Postgres, seeding a client and posting a workout.
//
// The cases below are chosen for where the rules can be WRONG rather than for
// coverage. Several of them — inverted pace, RIR's flipped direction,
// warm-ups counting as work — are mistakes that produce plausible-looking
// numbers, which is what makes them worth pinning.
'use strict';

const u = require('../modules/training/units');
const p = require('../modules/training/prescription');
const prog = require('../modules/training/progression');

const set = (over = {}) => ({
  completed: true, set_type: 'WORKING', actual_reps: 8,
  actual_weight: 100, weight_unit: 'kg', ...over,
});

describe('units', () => {
  test('kg and lb round-trip without drift', () => {
    expect(u.toKg(220.46226218487757, 'lb')).toBeCloseTo(100, 9);
    expect(u.fromKg(100, 'lb')).toBeCloseTo(220.46226218487757, 9);
    expect(u.toKg(100, 'kg')).toBe(100);
  });

  test('a mile is 1609.344 m, not 1600', () => {
    // The lazy constant is off by 0.58%, which on a 10 km PR is 58 metres —
    // enough to invent a record that was never set.
    expect(u.toMetres(1, 'mile')).toBe(1609.344);
    expect(u.toMetres(5, 'km')).toBe(5000);
  });

  test('an unknown unit is null, not a silent 1:1', () => {
    // Treating an unrecognised unit as metres is how "3 furlongs" becomes a
    // 3 metre PR.
    expect(u.toMetres(5, 'furlong')).toBeNull();
    expect(u.fromMetres(5000, 'furlong')).toBeNull();
  });

  test('pace units are the inverted ones', () => {
    expect(u.isInvertedSpeed('min_per_km')).toBe(true);
    expect(u.isInvertedSpeed('min_per_mile')).toBe(true);
    expect(u.isInvertedSpeed('kmh')).toBe(false);
  });

  test('5:00/km and 12 km/h are the same speed', () => {
    expect(u.toMetresPerSecond(5, 'min_per_km')).toBeCloseTo(u.toMetresPerSecond(12, 'kmh'), 6);
  });

  test('zero duration is null, not Infinity', () => {
    // Infinity propagates into every average it touches, and a 5 km run with
    // no elapsed time is missing data rather than infinite speed.
    expect(u.averageSpeedMps(5, 'km', 0)).toBeNull();
    expect(u.averageSpeedMps(5, 'km', null)).toBeNull();
  });

  test('pace is seconds over a reference distance', () => {
    // 2000 m in 8 minutes = 2:00 per 500 m, which is how a rower says it.
    expect(u.paceSeconds(2000, 'm', 480, 500)).toBe(120);
    expect(u.formatPace(120)).toBe('2:00');
    expect(u.formatPace(330)).toBe('5:30');
  });

  test('durations show hours only when there are any', () => {
    expect(u.formatDuration(1500)).toBe('25:00');
    expect(u.formatDuration(3930)).toBe('1:05:30');
  });

  test('weights round to something a gym actually has', () => {
    // 2.5% of 82.5 is 84.5625kg, which no plate arrangement makes.
    expect(u.roundToIncrement(84.5625, 2.5)).toBe(85);
    expect(u.roundToIncrement(83.1, 2.5)).toBe(82.5);
    expect(u.defaultIncrement('lb')).toBe(5);
  });
});

describe('prescription — which fields a type makes sense of', () => {
  test('every type is routed to a performance table', () => {
    for (const t of p.PRESCRIPTION_TYPES) {
      expect([t, ['sets', 'cardio', 'either'].includes(p.performanceKind(t))]).toEqual([t, true]);
    }
  });

  test('strength logs as sets, cardio as cardio', () => {
    expect(p.performanceKind('SETS_REPS')).toBe('sets');
    expect(p.performanceKind('PERCENT_1RM')).toBe('sets');
    expect(p.performanceKind('TIME_DISTANCE')).toBe('cardio');
    expect(p.performanceKind('TIME_SPEED')).toBe('cardio');
    expect(p.performanceKind('DISTANCE_LOAD')).toBe('cardio');
    expect(p.performanceKind('FLOORS')).toBe('cardio');
    expect(p.performanceKind('INTERVAL')).toBe('cardio');
  });

  test('CUSTOM says "either" rather than guessing', () => {
    expect(p.performanceKind('CUSTOM')).toBe('either');
  });

  test('a treadmill prescription validates with no sets or reps', () => {
    // The case the old schema could not represent at all.
    const r = p.validate({
      prescription_type: 'TIME_DISTANCE',
      target_duration_seconds: 1200, target_distance: 3, distance_unit: 'km',
      target_incline: 5, target_rpe: 7,
    });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  test('a prescription with nothing in it is an error', () => {
    const r = p.validate({ prescription_type: 'SETS_REPS' });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/needs at least one of/i);
  });

  test('a distance with no unit is refused', () => {
    const r = p.validate({ prescription_type: 'DISTANCE', target_distance: 5 });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/distance_unit/);
  });

  test('cardio modes do not require strength sets and reps', () => {
    expect(p.validate({
      prescription_type: 'TIME_SPEED', target_duration_seconds: 1200, target_speed: 8,
    }).valid).toBe(true);
    expect(p.validate({
      prescription_type: 'DISTANCE_LOAD', target_distance: 20, distance_unit: 'm', target_weight: 80,
    }).valid).toBe(true);
    expect(p.validate({ prescription_type: 'FLOORS', target_floors: 12 }).valid).toBe(true);
  });

  test('an out-of-range RPE is refused', () => {
    expect(p.validate({ prescription_type: 'RPE_BASED', target_rpe: 14 }).valid).toBe(false);
    expect(p.validate({ prescription_type: 'RPE_BASED', target_rpe: 8 }).valid).toBe(true);
  });

  test('a stale field is a warning, not a refusal', () => {
    // A trainer switching a row from SETS_REPS to TIME must be able to save.
    // Refusing until they hunt down every leftover field is how a validator
    // gets switched off.
    const r = p.validate({
      prescription_type: 'TIME', target_duration_seconds: 600, target_sets: 3,
    });
    expect(r.valid).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/target_sets/);
  });

  test('an unknown type is refused outright', () => {
    expect(p.validate({ prescription_type: 'NONSENSE' }).valid).toBe(false);
  });

  test('describes a prescription the way a trainer says it', () => {
    expect(p.describe({
      prescription_type: 'SETS_REPS', target_sets: 4, target_reps_min: 6,
      target_weight: 100, weight_unit: 'kg', target_rpe: 8, target_rest_seconds: 180,
    })).toBe('4 × 6 · 100kg · RPE 8 · rest 180s');

    expect(p.describe({
      prescription_type: 'TIME_DISTANCE', target_duration_seconds: 1200,
      target_distance: 3, distance_unit: 'km', target_incline: 5, target_rpe: 7,
    })).toBe('20 min · 3 km · 5% incline · RPE 7');

    expect(p.describe({
      prescription_type: 'DISTANCE_LOAD', target_distance: 20, distance_unit: 'm',
      target_weight: 80, weight_unit: 'kg', target_rounds: 5,
    })).toBe('5 rounds · 20 m · 80kg');
  });
});

describe('progression — proposals, never mutations', () => {
  const pres = {
    prescription_type: 'SETS_REPS', target_sets: 3,
    target_reps_min: 8, target_reps_max: 12, target_weight: 80, weight_unit: 'kg',
  };

  test('double progression adds weight only when EVERY set hits the top', () => {
    const all12 = [set({ actual_reps: 12 }), set({ actual_reps: 12 }), set({ actual_reps: 12 })];
    const r = prog.propose('DOUBLE_PROGRESSION', pres, all12);
    expect(r.changed).toBe(true);
    expect(r.patch.target_weight).toBe(82.5);
    expect(r.patch.target_reps_min).toBe(8);       // back to the bottom
  });

  test('one short set holds the weight', () => {
    // Averaging these would add weight the client cannot handle.
    const r = prog.propose('DOUBLE_PROGRESSION', pres, [
      set({ actual_reps: 12 }), set({ actual_reps: 12 }), set({ actual_reps: 8 }),
    ]);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/Lowest set was 8/);
  });

  test('a session with sets missing does not progress', () => {
    const r = prog.propose('DOUBLE_PROGRESSION', pres, [set({ actual_reps: 12 })]);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/1 of 3/);
  });

  test('RPE below target adds weight; above target backs off', () => {
    const rpePres = { ...pres, target_rpe: 8 };
    const easy = prog.propose('RPE_BASED', rpePres, [set({ actual_rpe: 6 }), set({ actual_rpe: 6.5 })]);
    expect(easy.changed).toBe(true);
    expect(easy.patch.target_weight).toBe(82.5);

    const hard = prog.propose('RPE_BASED', rpePres, [set({ actual_rpe: 9.5 }), set({ actual_rpe: 10 })]);
    expect(hard.patch.target_weight).toBe(77.5);
  });

  test('RIR runs the OTHER way — more reps left means add weight', () => {
    // RPE 10 and RIR 0 both mean failure. Getting this backwards deloads a
    // client who is progressing.
    const rirPres = { ...pres, target_rir: 2 };
    const easy = prog.propose('RIR_BASED', rirPres, [set({ actual_rir: 4 }), set({ actual_rir: 4 })]);
    expect(easy.changed).toBe(true);
    expect(easy.patch.target_weight).toBe(82.5);

    const hard = prog.propose('RIR_BASED', rirPres, [set({ actual_rir: 0 }), set({ actual_rir: 0 })]);
    expect(hard.patch.target_weight).toBe(77.5);
  });

  test('on-target RPE holds', () => {
    const r = prog.propose('RPE_BASED', { ...pres, target_rpe: 8 }, [set({ actual_rpe: 8 })]);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/on target/);
  });

  test('percent-1RM follows the estimate, rounded to real plates', () => {
    const r = prog.propose('PERCENT_1RM', { ...pres, percentage_1rm: 80 }, [], { oneRepMaxKg: 137 });
    expect(r.changed).toBe(true);
    expect(r.patch.target_weight).toBe(110);       // 109.6 → 110
  });

  test('percent-1RM says so when there is no estimate yet', () => {
    const r = prog.propose('PERCENT_1RM', { ...pres, percentage_1rm: 80 }, []);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/no estimated 1RM/i);
  });

  test('time progresses when the target was met', () => {
    const cp = { prescription_type: 'TIME', target_duration_seconds: 1200 };
    const met = prog.propose('TIME_PROGRESSION', cp, { completed: true, duration_seconds: 1200 });
    expect(met.patch.target_duration_seconds).toBe(1320);
    const short = prog.propose('TIME_PROGRESSION', cp, { completed: true, duration_seconds: 900 });
    expect(short.changed).toBe(false);
  });

  test('distance compares in metres, so units may differ', () => {
    // A 5 km target run as 5000 m is the target met, not a shortfall.
    const cp = { prescription_type: 'DISTANCE', target_distance: 5, distance_unit: 'km' };
    const r = prog.propose('DISTANCE_PROGRESSION', cp, {
      completed: true, distance: 5000, distance_unit: 'm',
    });
    expect(r.changed).toBe(true);
    expect(r.patch.target_distance).toBe(5.5);
  });

  test('pace progresses DOWNWARD', () => {
    const cp = { prescription_type: 'PACE', target_pace_seconds: 300 };
    const held = prog.propose('PACE_PROGRESSION', cp, { completed: true, pace_seconds: 298 });
    expect(held.patch.target_pace_seconds).toBe(295);
    const missed = prog.propose('PACE_PROGRESSION', cp, { completed: true, pace_seconds: 310 });
    expect(missed.changed).toBe(false);
  });

  test('caps and floors are respected', () => {
    const cp = { prescription_type: 'TIME', target_duration_seconds: 1800 };
    const r = prog.propose('TIME_PROGRESSION', cp, { completed: true, duration_seconds: 1800 }, { cap: 1800 });
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/capped/);
  });

  test('an unknown rule holds the exercise rather than throwing', () => {
    // This runs while building a whole week. A typo must not take the build
    // down — it must leave one exercise unchanged and say so.
    const r = prog.propose('TYPO_PROGRESSION', pres, []);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/Unknown progression type/);
  });

  test('every proposal carries a reason a trainer can read', () => {
    for (const type of prog.PROGRESSION_TYPES) {
      const r = prog.propose(type, pres, []);
      expect([type, typeof r.reason]).toEqual([type, 'string']);
      expect([type, r.reason.length > 0]).toEqual([type, true]);
    }
  });
});
