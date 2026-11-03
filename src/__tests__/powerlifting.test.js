// The powerlifting block is the part of the workout system that has to be
// right about time: a peaking week prescribed in week 2, or a taper that
// never tapers, is not a formatting bug. These tests pin the phase sequence,
// the %TM arithmetic and the refusal to invent a max.
'use strict';

const {
  PHASE_ORDER,
  phaseAllocation,
  phasePlan,
  prescribeLift,
  classifyLift,
  trainingMaxFromE1RM,
  suggestTrainingMax,
  estimateE1RM,
  roundToIncrement,
  weekMeta,
} = require('../modules/pt-os/powerlifting');

describe('phase allocation', () => {
  it('runs Base → Strength → Intensification → Peaking → Taper on a long block', () => {
    const { phases, plan } = phasePlan(12);
    expect(phases.map((p) => p.phase)).toEqual(PHASE_ORDER);
    expect(phases.map((p) => p.weeks.length).reduce((a, b) => a + b, 0)).toBe(12);
    expect(plan).toHaveLength(12);
    expect(plan[0]).toMatchObject({ week: 1, phase: 'base' });
    expect(plan[11]).toMatchObject({ week: 12, phase: 'taper' });
  });

  it('keeps every phase and adds up exactly for any block length', () => {
    for (let weeks = 5; weeks <= 24; weeks += 1) {
      const allocation = phaseAllocation(weeks);
      expect(allocation.map((p) => p.phase)).toEqual(PHASE_ORDER);
      expect(allocation.reduce((sum, p) => sum + p.weeks, 0)).toBe(weeks);
      expect(allocation.every((p) => p.weeks >= 1)).toBe(true);
    }
  });

  it('collapses a short block instead of pretending it has five phases', () => {
    expect(phaseAllocation(1)).toEqual([{ phase: 'base', weeks: 1 }]);
    expect(phaseAllocation(3).map((p) => p.phase)).toEqual(['base', 'intensification', 'taper']);
    expect(phaseAllocation(4).map((p) => p.phase)).toEqual(['base', 'strength', 'peaking', 'taper']);
  });

  it('puts a deload at the end of Base only when the block has earned one', () => {
    const long = phasePlan(12);
    const deloads = long.plan.filter((w) => w.is_deload);
    expect(deloads).toHaveLength(1);
    expect(deloads[0].phase).toBe('base');
    expect(deloads[0].week).toBe(long.phases[0].end_week);

    expect(phasePlan(4).plan.some((w) => w.is_deload)).toBe(false);
  });
});

describe('prescription', () => {
  it('loads a competition lift as a percentage of the training max', () => {
    const rx = prescribeLift({
      lift: 'squat', phase: 'base', weekInPhase: 1, phaseWeeks: 3, trainingMaxKg: 200,
    });
    expect(rx.basis).toBe('training_max');
    expect(rx.target_weight).toBe(130); // 65% of 200
    expect(rx.intensityPct1RM).toBe(65);
    expect(rx.sets).toBe(5);
    expect(rx.reps).toBe('5');
    expect(rx.rpe).toBe(6.5);
    expect(rx.rir).toBe(3.5);
    expect(rx.notes).toMatch(/65% of a 200 kg training max/);
  });

  it('raises intensity and cuts volume across a phase', () => {
    const first = prescribeLift({ lift: 'bench', phase: 'intensification', weekInPhase: 1, phaseWeeks: 3, trainingMaxKg: 100 });
    const last = prescribeLift({ lift: 'bench', phase: 'intensification', weekInPhase: 3, phaseWeeks: 3, trainingMaxKg: 100 });
    expect(last.intensityPct1RM).toBeGreaterThan(first.intensityPct1RM);
    expect(last.sets).toBeLessThanOrEqual(first.sets);
    expect(Number(last.reps)).toBeLessThanOrEqual(Number(first.reps));
    expect(last.rpe).toBeGreaterThan(first.rpe);
    expect(last.rir).toBeLessThan(first.rir);
  });

  it('tapers by lowering load and effort, not by adding work', () => {
    const start = prescribeLift({ lift: 'deadlift', phase: 'taper', weekInPhase: 1, phaseWeeks: 2, trainingMaxKg: 250 });
    const end = prescribeLift({ lift: 'deadlift', phase: 'taper', weekInPhase: 2, phaseWeeks: 2, trainingMaxKg: 250 });
    expect(end.intensityPct1RM).toBeLessThan(start.intensityPct1RM);
    expect(end.sets).toBe(start.sets);
    expect(end.rpe).toBeLessThan(start.rpe);
  });

  it('halves the sets on a deload and says so', () => {
    const normal = prescribeLift({ lift: 'squat', phase: 'base', weekInPhase: 3, phaseWeeks: 3, trainingMaxKg: 200 });
    const deload = prescribeLift({ lift: 'squat', phase: 'base', weekInPhase: 3, phaseWeeks: 3, trainingMaxKg: 200, isDeload: true });
    expect(deload.sets).toBeLessThan(normal.sets);
    expect(deload.target_weight).toBeLessThan(normal.target_weight);
    expect(deload.is_deload).toBe(true);
    expect(deload.notes).toMatch(/Deload week/);
  });

  it('refuses to invent a load without a training max', () => {
    const rx = prescribeLift({ lift: 'squat', phase: 'strength', weekInPhase: 2, phaseWeeks: 2 });
    expect(rx.target_weight).toBeNull();
    expect(rx.intensityPct1RM).toBeNull();
    expect(rx.basis).toBe('rpe');
    expect(rx.notes).toMatch(/RPE-only/);
    // The effort target is still there: the set can be performed and logged.
    expect(rx.rpe).toBeGreaterThan(0);
    expect(rx.rir).toBeGreaterThanOrEqual(0);
  });

  it('rejects an unknown phase rather than defaulting to one', () => {
    expect(() => prescribeLift({ lift: 'squat', phase: 'hypertrophy' })).toThrow(/Unknown powerlifting phase/);
  });
});

describe('lift classification', () => {
  it('recognises the competition lifts and their variants', () => {
    expect(classifyLift('Back Squat', 'Squat')).toBe('squat');
    expect(classifyLift('Competition Bench Press', 'Horizontal Push')).toBe('bench');
    expect(classifyLift('Conventional Deadlift', 'Hinge')).toBe('deadlift');
  });

  it('does not turn a front squat or a Romanian deadlift into a competition max', () => {
    expect(classifyLift('Front Squat', 'Squat')).toBeNull();
    expect(classifyLift('Romanian Deadlift', 'Hinge')).toBeNull();
    expect(classifyLift('Goblet Squat', 'Squat')).toBeNull();
    expect(classifyLift('Overhead Press', 'Vertical Push')).toBeNull();
  });

  it('needs a name it can actually read', () => {
    expect(classifyLift('', 'Squat')).toBeNull();
    expect(classifyLift('Leg Press', 'Squat')).toBeNull();
  });
});

describe('training max', () => {
  it('derives a max below the logged e1RM, by experience', () => {
    expect(trainingMaxFromE1RM(100, 'beginner')).toBe(85);
    expect(trainingMaxFromE1RM(100, 'intermediate')).toBe(90);
    expect(trainingMaxFromE1RM(100, 'advanced')).toBe(92.5);
  });

  it('rounds to a loadable increment and refuses nonsense', () => {
    expect(trainingMaxFromE1RM(103, 'intermediate')).toBe(92.5);
    expect(trainingMaxFromE1RM(0, 'intermediate')).toBeNull();
    expect(trainingMaxFromE1RM(null, 'intermediate')).toBeNull();
    expect(roundToIncrement(101.2)).toBe(100);
  });

  it('reuses the same Epley estimate as training history', () => {
    expect(estimateE1RM(100, 5)).toBe(116.7);
    expect(estimateE1RM(0, 5)).toBeNull();
  });

  it('suggests a max from evidence and never applies it', () => {
    const suggestion = suggestTrainingMax({ bestE1rmKg: 120, experience: 'intermediate' });
    expect(suggestion).toMatchObject({ suggested_kg: 107.5, applied: false });
    expect(suggestion.reason).toMatch(/e1RM/);
  });

  it('holds the max after an RPE 9.5 top set that does not support more', () => {
    const suggestion = suggestTrainingMax({
      currentTrainingMaxKg: 100, bestE1rmKg: 105, experience: 'intermediate', lastRpe: 9.5,
    });
    expect(suggestion.suggested_kg).toBe(100);
    expect(suggestion.reason).toMatch(/Hold/);
    expect(suggestion.applied).toBe(false);
  });

  it('says when there is no evidence at all', () => {
    const suggestion = suggestTrainingMax({});
    expect(suggestion.suggested_kg).toBeNull();
    expect(suggestion.reason).toMatch(/No e1RM or training max/);
  });
});

describe('stored block lookup', () => {
  it('finds the week metadata a plan persisted', () => {
    const block = phasePlan(6).plan;
    expect(weekMeta(block, 1)).toMatchObject({ week: 1, phase: 'base' });
    expect(weekMeta(block, 6)).toMatchObject({ week: 6, phase: 'taper' });
    expect(weekMeta(block, 99)).toBeNull();
    expect(weekMeta(null, 1)).toBeNull();
  });
});
