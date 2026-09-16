// A number a trainer typed into the generator form went to the model unchecked.
//
// The database paths were already bounded — `ageFromDob` refuses anything
// outside [0, 130), `countDays` refuses a week with more than seven days — but
// `num(stated[field])` was not. A typo in the AI generator form reached the
// prompt as a fact about a real person:
//
//     - Weight: 750 (stated by the trainer for this session, not on file)
//
// and the model wrote a training programme around it. Out of range now
// resolves to null, which the engine already reports as `missing` — a gap the
// trainer can see and fill beats a number nobody checked.

const {
  resolveClientFacts, numInRange, STATED_RANGE, BLOCKING, FIELDS,
} = require('../modules/pt-os/client-facts');

/** A context with nothing on file, so every fact must come from `stated`. */
const emptyCtx = () => ({
  client: {},
  profile: null,
  goals: [],
  latestAssessment: null,
  latestCheckin: null,
  lifestyle: null,
  workoutAssignments: [],
  studioEquipment: null,
});

const factOf = (stated, field) => resolveClientFacts(emptyCtx(), stated).facts[field];

describe('numInRange', () => {
  test('passes a value inside the range through unchanged', () => {
    expect(numInRange('75', 'weight_kg')).toBe(75);
  });

  test.each([
    ['age', 9], ['age', 121],
    ['weight_kg', 19], ['weight_kg', 401],
    ['height_cm', 89], ['height_cm', 261],
    ['training_days', 0], ['training_days', 8],
  ])('refuses %s = %p', (field, value) => {
    expect(numInRange(value, field)).toBeNull();
  });

  test.each([
    ['age', 10], ['age', 120],
    ['weight_kg', 20], ['weight_kg', 400],
    ['height_cm', 90], ['height_cm', 260],
    ['training_days', 1], ['training_days', 7],
  ])('accepts %s = %p, the edge of the range', (field, value) => {
    expect(numInRange(value, field)).toBe(value);
  });

  test('refuses a negative weight', () => {
    expect(numInRange(-70, 'weight_kg')).toBeNull();
  });

  test('still refuses what is not a number at all', () => {
    expect(numInRange('abc', 'age')).toBeNull();
    expect(numInRange('', 'age')).toBeNull();
    expect(numInRange(null, 'age')).toBeNull();
  });

  test('leaves a field with no declared range alone', () => {
    expect(numInRange(42, 'not_a_ranged_field')).toBe(42);
  });

  // The bounds exclude the impossible, not the unusual.
  test('accepts a 95-year-old client and a 180kg client', () => {
    expect(numInRange(95, 'age')).toBe(95);
    expect(numInRange(180, 'weight_kg')).toBe(180);
  });
});

describe('a stated fact that is out of range', () => {
  test('is reported as missing rather than told to the model', () => {
    const fact = factOf({ weight_kg: 750 }, 'weight_kg');
    expect(fact).toEqual({ value: null, source: null, origin: 'missing' });
  });

  test('appears in the data-quality report, so the trainer can fill it', () => {
    const { data_quality: dq } = resolveClientFacts(emptyCtx(), { age: 3 });
    expect(dq.missing.map((m) => m.field)).toContain('age');
    expect(dq.stated.map((m) => m.field)).not.toContain('age');
  });

  test('is flagged blocking where the field blocks generation', () => {
    const { data_quality: dq } = resolveClientFacts(emptyCtx(), { training_days: 400 });
    expect(BLOCKING).toContain('training_days');
    expect(dq.blocking).toContain('training_days');
  });

  test('does not stop a sound value in the same request', () => {
    const { facts } = resolveClientFacts(emptyCtx(), { age: 3, weight_kg: 82 });
    expect(facts.age.origin).toBe('missing');
    expect(facts.weight_kg).toEqual({ value: 82, source: 'trainer', origin: 'stated' });
  });
});

describe('a stated fact inside the range', () => {
  const ownRangedFields = FIELDS.filter((f) => f in STATED_RANGE);

  test('covers every numeric fact this module resolves', () => {
    expect(ownRangedFields.sort()).toEqual(['age', 'height_cm', 'training_days', 'weight_kg']);
  });

  test.each(ownRangedFields)('%s is still marked as stated by the trainer', (field) => {
    const mid = Math.round((STATED_RANGE[field][0] + STATED_RANGE[field][1]) / 2);
    expect(factOf({ [field]: mid }, field)).toEqual({
      value: mid, source: 'trainer', origin: 'stated',
    });
  });

  // `meal_frequency` is the diet generator's, not this module's. It shares the
  // table so both prompts refuse the same impossible values — see
  // resolveDietInputs in routes/ai.js — which is why it has a range here and
  // no fact.
  test('meal_frequency is bounded here but resolved elsewhere', () => {
    expect(STATED_RANGE.meal_frequency).toEqual([1, 12]);
    expect(FIELDS).not.toContain('meal_frequency');
    expect(numInRange(40, 'meal_frequency')).toBeNull();
    expect(numInRange(5, 'meal_frequency')).toBe(5);
  });
});
