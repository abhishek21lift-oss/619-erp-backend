// K11 muscular-strength norms, transcribed from the supplied reference.
//
// The backend copy is what actually stores the category, so these assertions
// are the record's source of truth. The frontend copy is held to the same
// answers by its own k11-strength-norms.test.ts and by
// scripts/assert-scoring-parity.ts.
'use strict';

const fitness = require('../modules/progress/fitness-scoring');

const SEXES = ['Male', 'Female'];
const EXERCISES = ['Bench Press', 'Leg Press'];
const BANDS = ['20-29', '30-39', '40-49', '50-59', '60+'];

/** [percentile, minimum ratio], highest percentile first. */
const NORMS = {
  Male: {
    'Bench Press': {
      '20-29': [[90, 1.48], [80, 1.32], [70, 1.22], [60, 1.14], [50, 1.06], [40, 0.99], [30, 0.93], [20, 0.88], [10, 0.80]],
      '30-39': [[90, 1.24], [80, 1.12], [70, 1.04], [60, 0.98], [50, 0.93], [40, 0.88], [30, 0.83], [20, 0.78], [10, 0.71]],
      '40-49': [[90, 1.10], [80, 1.00], [70, 0.93], [60, 0.88], [50, 0.84], [40, 0.80], [30, 0.76], [20, 0.72], [10, 0.65]],
      '50-59': [[90, 0.97], [80, 0.90], [70, 0.84], [60, 0.79], [50, 0.75], [40, 0.71], [30, 0.68], [20, 0.63], [10, 0.57]],
      '60+':   [[90, 0.89], [80, 0.82], [70, 0.77], [60, 0.72], [50, 0.68], [40, 0.66], [30, 0.63], [20, 0.57], [10, 0.53]],
    },
    'Leg Press': {
      '20-29': [[90, 2.27], [80, 2.13], [70, 2.05], [60, 1.97], [50, 1.91], [40, 1.83], [30, 1.74], [20, 1.63], [10, 1.51]],
      '30-39': [[90, 2.07], [80, 1.93], [70, 1.85], [60, 1.77], [50, 1.71], [40, 1.65], [30, 1.59], [20, 1.52], [10, 1.43]],
      '40-49': [[90, 1.92], [80, 1.82], [70, 1.74], [60, 1.68], [50, 1.62], [40, 1.57], [30, 1.51], [20, 1.44], [10, 1.35]],
      '50-59': [[90, 1.80], [80, 1.71], [70, 1.64], [60, 1.58], [50, 1.52], [40, 1.46], [30, 1.39], [20, 1.32], [10, 1.22]],
      '60+':   [[90, 1.73], [80, 1.62], [70, 1.56], [60, 1.49], [50, 1.43], [40, 1.38], [30, 1.30], [20, 1.25], [10, 1.16]],
    },
  },
  Female: {
    // No 10th-percentile row was supplied for female tables — do not invent one.
    'Bench Press': {
      '20-29': [[90, 0.90], [80, 0.80], [70, 0.74], [60, 0.70], [50, 0.65], [40, 0.59], [30, 0.56], [20, 0.51]],
      '30-39': [[90, 0.76], [80, 0.70], [70, 0.63], [60, 0.60], [50, 0.57], [40, 0.53], [30, 0.51], [20, 0.47]],
      '40-49': [[90, 0.71], [80, 0.62], [70, 0.57], [60, 0.54], [50, 0.52], [40, 0.50], [30, 0.47], [20, 0.43]],
      '50-59': [[90, 0.61], [80, 0.55], [70, 0.52], [60, 0.48], [50, 0.46], [40, 0.44], [30, 0.42], [20, 0.39]],
      '60+':   [[90, 0.64], [80, 0.54], [70, 0.51], [60, 0.47], [50, 0.45], [40, 0.43], [30, 0.40], [20, 0.38]],
    },
    'Leg Press': {
      '20-29': [[90, 1.82], [80, 1.68], [70, 1.58], [60, 1.50], [50, 1.44], [40, 1.37], [30, 1.27], [20, 1.22]],
      '30-39': [[90, 1.61], [80, 1.47], [70, 1.39], [60, 1.33], [50, 1.27], [40, 1.21], [30, 1.15], [20, 1.09]],
      '40-49': [[90, 1.48], [80, 1.37], [70, 1.29], [60, 1.23], [50, 1.18], [40, 1.13], [30, 1.08], [20, 1.02]],
      '50-59': [[90, 1.37], [80, 1.25], [70, 1.17], [60, 1.10], [50, 1.05], [40, 0.99], [30, 0.95], [20, 0.88]],
      '60+':   [[90, 1.32], [80, 1.18], [70, 1.13], [60, 1.04], [50, 0.99], [40, 0.93], [30, 0.88], [20, 0.85]],
    },
  },
};

const CATEGORY_BY_PERCENTILE = {
  90: 'Well Above Average', 80: 'Well Above Average',
  70: 'Above Average', 60: 'Above Average',
  50: 'Average',
  40: 'Below Average', 30: 'Below Average',
  20: 'Well Below Average', 10: 'Well Below Average',
};

const SCORE_BY_PERCENTILE = {
  90: 90, 80: 90, 70: 70, 60: 70, 50: 60, 40: 40, 30: 40, 20: 20, 10: 20,
};

const BAND_AGES = {
  '20-29': [20, 29],
  '30-39': [30, 39],
  '40-49': [40, 49],
  '50-59': [50, 59],
  '60+': [60, 95],
};

/** A 0.01-ratio in kg against a 100 kg body weight. */
const ratioAt = (ratio) => Number(ratio.toFixed(2)) * 100;

describe('K11 strength — every supplied threshold', () => {
  for (const sex of SEXES) {
    for (const exercise of EXERCISES) {
      for (const band of BANDS) {
        const rows = NORMS[sex][exercise][band];
        test(`${sex} ${exercise} ${band}`, () => {
          for (const [percentile, minimum] of rows) {
            const index = rows.findIndex(([p]) => p === percentile);
            const below = rows[index + 1];
            for (const age of BAND_AGES[band]) {
              expect(fitness.classifyStrengthDetail(ratioAt(minimum), 100, exercise, sex, age)).toEqual({
                category: CATEGORY_BY_PERCENTILE[percentile],
                percentile,
                ratio: minimum,
                ageBand: band,
              });
              expect(fitness.classifyStrengthDetail(ratioAt(minimum + 0.01), 100, exercise, sex, age).percentile).toBe(percentile);
              const under = fitness.classifyStrengthDetail(ratioAt(minimum - 0.01), 100, exercise, sex, age);
              if (below) {
                expect(under).toMatchObject({ percentile: below[0], category: CATEGORY_BY_PERCENTILE[below[0]] });
              } else {
                expect(under).toMatchObject({ percentile: null, category: 'Below Supported Range' });
              }
            }
          }
        });
      }
    }
  }
});

describe('K11 strength — percentile and category stay separate', () => {
  test('groups the supplied percentiles but keeps the detail', () => {
    const at = (percentile) => {
      const row = NORMS.Male['Bench Press']['20-29'].find(([p]) => p === percentile);
      return fitness.classifyStrengthDetail(ratioAt(row[1]), 100, 'Bench Press', 'Male', 25);
    };
    expect(at(90)).toMatchObject({ category: 'Well Above Average', percentile: 90 });
    expect(at(80)).toMatchObject({ category: 'Well Above Average', percentile: 80 });
    expect(at(70)).toMatchObject({ category: 'Above Average', percentile: 70 });
    expect(at(60)).toMatchObject({ category: 'Above Average', percentile: 60 });
    expect(at(50)).toMatchObject({ category: 'Average', percentile: 50 });
    expect(at(40)).toMatchObject({ category: 'Below Average', percentile: 40 });
    expect(at(30)).toMatchObject({ category: 'Below Average', percentile: 30 });
    expect(at(20)).toMatchObject({ category: 'Well Below Average', percentile: 20 });
    expect(at(10)).toMatchObject({ category: 'Well Below Average', percentile: 10 });
  });

  test('maps every category onto its 0-100 dashboard score', () => {
    for (const [percentile, category] of Object.entries(CATEGORY_BY_PERCENTILE)) {
      expect(fitness.scoreCategory(category)).toBe(SCORE_BY_PERCENTILE[percentile]);
    }
    expect(fitness.scoreCategory('Below Supported Range')).toBe(20);
  });

  test('uses 1RM divided by body weight', () => {
    // 120 kg at 80 kg = 1.50, male 20-29 bench >= 1.48 → 90th.
    expect(fitness.classifyStrengthDetail(120, 80, 'Bench Press', 'Male', 25)).toMatchObject({
      category: 'Well Above Average', percentile: 90, ratio: 1.5,
    });
    expect(fitness.classifyStrength(120, 80, 'Bench Press', 'Male', 25)).toBe('Well Above Average');
  });
});

describe('K11 strength — age bands', () => {
  test('selects the band from the age at testing', () => {
    expect(fitness.strengthAgeBand(20)).toBe('20-29');
    expect(fitness.strengthAgeBand(29)).toBe('20-29');
    expect(fitness.strengthAgeBand(30)).toBe('30-39');
    expect(fitness.strengthAgeBand(39)).toBe('30-39');
    expect(fitness.strengthAgeBand(40)).toBe('40-49');
    expect(fitness.strengthAgeBand(49)).toBe('40-49');
    expect(fitness.strengthAgeBand(50)).toBe('50-59');
    expect(fitness.strengthAgeBand(59)).toBe('50-59');
    expect(fitness.strengthAgeBand(60)).toBe('60+');
    expect(fitness.strengthAgeBand(95)).toBe('60+');
  });

  test('has no band under 20 or for a missing/invalid age', () => {
    for (const age of [null, 0, 19, 19.9, NaN, Infinity]) {
      expect(fitness.strengthAgeBand(age)).toBeNull();
      expect(fitness.classifyStrengthDetail(100, 80, 'Bench Press', 'Male', age)).toBeNull();
      expect(fitness.classifyStrength(100, 80, 'Bench Press', 'Male', age)).toBeNull();
    }
  });

  test('changes the percentile at a band transition with the same ratio', () => {
    expect(fitness.classifyStrengthDetail(106, 100, 'Bench Press', 'Male', 29).percentile).toBe(50);
    expect(fitness.classifyStrengthDetail(106, 100, 'Bench Press', 'Male', 30).percentile).toBe(70);
    expect(fitness.classifyStrengthDetail(110, 100, 'Bench Press', 'Male', 40).percentile).toBe(90);
    expect(fitness.strengthAgeBand(29.9)).toBe('20-29');
    expect(fitness.strengthAgeBand(30)).toBe('30-39');
  });
});

describe('K11 strength — invalid data never produces a category', () => {
  test('rejects missing, zero, negative and non-finite measurements', () => {
    for (const oneRM of [null, 0, -1, -0.1, NaN, Infinity, -Infinity]) {
      expect(fitness.classifyStrength(oneRM, 80, 'Bench Press', 'Male', 30)).toBeNull();
      expect(fitness.classifyStrengthDetail(oneRM, 80, 'Bench Press', 'Male', 30)).toBeNull();
    }
    for (const bodyWeight of [null, 0, -1, NaN, Infinity]) {
      expect(fitness.classifyStrength(100, bodyWeight, 'Bench Press', 'Male', 30)).toBeNull();
      expect(fitness.classifyStrengthDetail(100, bodyWeight, 'Bench Press', 'Male', 30)).toBeNull();
    }
  });

  test('rejects missing and unsupported sex, accepting canonical case', () => {
    for (const gender of [null, undefined, 'Other']) {
      expect(fitness.classifyStrength(100, 80, 'Bench Press', gender, 30)).toBeNull();
    }
    expect(fitness.classifyStrength(100, 80, 'Bench Press', 'male', 30)).not.toBeNull();
  });

  test('labels a valid ratio below the lowest supplied row without a percentile', () => {
    expect(fitness.classifyStrengthDetail(52, 100, 'Bench Press', 'Male', 65)).toEqual({
      category: 'Below Supported Range', percentile: null, ratio: 0.52, ageBand: '60+',
    });
    expect(fitness.classifyStrengthDetail(50, 100, 'Bench Press', 'Female', 25)).toEqual({
      category: 'Below Supported Range', percentile: null, ratio: 0.5, ageBand: '20-29',
    });
  });
});

describe('K11 strength — only supplied exercises', () => {
  test('returns no K11 category for Squat, Deadlift, Shoulder Press or custom lifts', () => {
    for (const exercise of [null, 'Squat', 'Deadlift', 'Shoulder Press', 'Lunges', 'Custom Exercise']) {
      expect(fitness.classifyStrengthDetail(150, 80, exercise, 'Male', 30)).toBeNull();
      expect(fitness.classifyStrength(150, 80, exercise, 'Male', 30)).toBeNull();
    }
  });

  test('covers Bench Press and Leg Press only', () => {
    expect(fitness.classifyStrength(100, 100, 'Bench Press', 'Male', 30)).not.toBeNull();
    expect(fitness.classifyStrength(200, 100, 'Leg Press', 'Male', 30)).not.toBeNull();
  });

  test('never returns the retired Excellent/Good/Poor labels', () => {
    const labels = new Set();
    for (const exercise of EXERCISES) for (const sex of SEXES) {
      for (const [, minimum] of NORMS[sex][exercise]['20-29']) {
        labels.add(fitness.classifyStrength(ratioAt(minimum), 100, exercise, sex, 25));
      }
    }
    expect([...labels]).not.toContain('Excellent');
    expect([...labels]).not.toContain('Good');
    expect([...labels]).not.toContain('Poor');
  });
});
