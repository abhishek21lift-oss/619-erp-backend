// K11 cardiorespiratory, muscular-endurance, flexibility and body-composition
// norms. The values are transcribed from the supplied K11 tables; every
// threshold is asserted at the edge and one step below it, so a moved edge or a
// transposed row cannot pass. The frontend twin is checked separately and by
// scripts/assert-scoring-parity.ts.
'use strict';

const fitness = require('../modules/progress/fitness-scoring');
const flexibility = require('../modules/progress/flexibility-protocol');

const SEXES = ['Male', 'Female'];

// [minimum VO2max, category], highest category first. The final threshold is
// the Poor floor; anything below it is Very Poor.
const VO2_NORMS = {
  Male: {
    15: [[57, 'Superior'], [56, 'Excellent'], [51, 'Very Good'], [46, 'Good'], [41, 'Fair'], [35, 'Poor']],
    20: [[56, 'Superior'], [55, 'Excellent'], [50, 'Very Good'], [45, 'Good'], [40, 'Fair'], [35, 'Poor']],
    25: [[55, 'Superior'], [54, 'Excellent'], [49, 'Very Good'], [44, 'Good'], [39, 'Fair'], [34, 'Poor']],
    30: [[54, 'Superior'], [53, 'Excellent'], [48, 'Very Good'], [43, 'Good'], [38, 'Fair'], [33, 'Poor']],
    35: [[53, 'Superior'], [52, 'Excellent'], [47, 'Very Good'], [42, 'Good'], [37, 'Fair'], [32, 'Poor']],
    40: [[52, 'Superior'], [51, 'Excellent'], [46, 'Very Good'], [41, 'Good'], [36, 'Fair'], [31, 'Poor']],
    45: [[51, 'Superior'], [50, 'Excellent'], [45, 'Very Good'], [40, 'Good'], [35, 'Fair'], [30, 'Poor']],
    50: [[50, 'Superior'], [49, 'Excellent'], [44, 'Very Good'], [39, 'Good'], [34, 'Fair'], [29, 'Poor']],
    55: [[49, 'Superior'], [48, 'Excellent'], [43, 'Very Good'], [38, 'Good'], [33, 'Fair'], [28, 'Poor']],
    60: [[48, 'Superior'], [47, 'Excellent'], [42, 'Very Good'], [37, 'Good'], [32, 'Fair'], [27, 'Poor']],
    65: [[47, 'Superior'], [46, 'Excellent'], [41, 'Very Good'], [36, 'Good'], [31, 'Fair'], [26, 'Poor']],
  },
  Female: {
    15: [[54, 'Superior'], [53, 'Excellent'], [48, 'Very Good'], [43, 'Good'], [38, 'Fair'], [33, 'Poor']],
    20: [[53, 'Superior'], [52, 'Excellent'], [47, 'Very Good'], [42, 'Good'], [37, 'Fair'], [32, 'Poor']],
    25: [[52, 'Superior'], [51, 'Excellent'], [46, 'Very Good'], [41, 'Good'], [36, 'Fair'], [31, 'Poor']],
    30: [[51, 'Superior'], [50, 'Excellent'], [45, 'Very Good'], [40, 'Good'], [35, 'Fair'], [30, 'Poor']],
    35: [[50, 'Superior'], [49, 'Excellent'], [44, 'Very Good'], [39, 'Good'], [34, 'Fair'], [29, 'Poor']],
    40: [[49, 'Superior'], [48, 'Excellent'], [43, 'Very Good'], [38, 'Good'], [33, 'Fair'], [28, 'Poor']],
    45: [[48, 'Superior'], [47, 'Excellent'], [42, 'Very Good'], [37, 'Good'], [32, 'Fair'], [27, 'Poor']],
    50: [[47, 'Superior'], [46, 'Excellent'], [41, 'Very Good'], [36, 'Good'], [31, 'Fair'], [26, 'Poor']],
    55: [[46, 'Superior'], [45, 'Excellent'], [40, 'Very Good'], [35, 'Good'], [30, 'Fair'], [25, 'Poor']],
    60: [[45, 'Superior'], [44, 'Excellent'], [39, 'Very Good'], [34, 'Good'], [29, 'Fair'], [24, 'Poor']],
    65: [[44, 'Superior'], [43, 'Excellent'], [38, 'Very Good'], [33, 'Good'], [28, 'Fair'], [23, 'Poor']],
  },
};

/** Ages inside each five-year K11 row, including the row's last year. */
const VO2_AGES = {
  15: [15, 19], 20: [20, 24], 25: [25, 29], 30: [30, 34], 35: [35, 39],
  40: [40, 44], 45: [45, 49], 50: [50, 54], 55: [55, 59], 60: [60, 64], 65: [65, 90],
};

// [minimum repetitions, category], highest category first. Anything below the
// Fair floor is Poor.
const PUSHUP_NORMS = {
  Male: {
    '20-29': [[36, 'Excellent'], [29, 'Very Good'], [22, 'Good'], [17, 'Fair']],
    '30-39': [[30, 'Excellent'], [22, 'Very Good'], [17, 'Good'], [12, 'Fair']],
    '40-49': [[25, 'Excellent'], [17, 'Very Good'], [13, 'Good'], [10, 'Fair']],
    '50-59': [[21, 'Excellent'], [13, 'Very Good'], [10, 'Good'], [7, 'Fair']],
    '60-69': [[18, 'Excellent'], [11, 'Very Good'], [8, 'Good'], [5, 'Fair']],
  },
  Female: {
    '20-29': [[30, 'Excellent'], [21, 'Very Good'], [15, 'Good'], [10, 'Fair']],
    '30-39': [[27, 'Excellent'], [20, 'Very Good'], [13, 'Good'], [8, 'Fair']],
    '40-49': [[24, 'Excellent'], [15, 'Very Good'], [11, 'Good'], [5, 'Fair']],
    '50-59': [[21, 'Excellent'], [11, 'Very Good'], [7, 'Good'], [2, 'Fair']],
    '60-69': [[17, 'Excellent'], [12, 'Very Good'], [5, 'Good'], [2, 'Fair']],
  },
};

const PUSHUP_AGES = {
  '20-29': [20, 29], '30-39': [30, 39], '40-49': [40, 49], '50-59': [50, 59], '60-69': [60, 69],
};

// [percentile, minimum repetitions], highest percentile first.
const CURLUP_NORMS = {
  Male: {
    '20-29': [[90, 75], [80, 56], [60, 31], [50, 27], [40, 23], [20, 13]],
    '30-39': [[90, 75], [80, 69], [60, 36], [50, 31], [40, 26], [20, 13]],
    '40-49': [[90, 75], [80, 75], [60, 51], [50, 39], [40, 31], [20, 21]],
    '50-59': [[90, 74], [80, 60], [60, 35], [50, 27], [40, 23], [20, 13]],
    '60-69': [[90, 53], [80, 33], [60, 19], [50, 16], [40, 9], [20, 0]],
  },
  Female: {
    '20-29': [[90, 70], [80, 45], [60, 32], [50, 27], [40, 21], [20, 12]],
    '30-39': [[90, 55], [80, 43], [60, 28], [50, 21], [40, 15], [20, 0]],
    '40-49': [[90, 50], [80, 42], [60, 28], [50, 25], [40, 20], [20, 5]],
    '50-59': [[90, 48], [80, 30], [60, 16], [50, 9], [40, 2], [20, 0]],
    '60-69': [[90, 50], [80, 30], [60, 19], [50, 9], [40, 3], [20, 0]],
  },
};

const CURLUP_CATEGORY = {
  90: 'Well Above Average', 80: 'Above Average',
  60: 'Average', 50: 'Average',
  40: 'Below Average', 20: 'Well Below Average',
};

// [minimum raw inches, category], highest category first. K11 prints integer
// ranges with gaps; the minimum of each printed range is the category floor,
// and anything below the lowest floor is Well Below Average.
const SIT_AND_REACH_NORMS = {
  Male: {
    '18-25': [[22, 'Excellent'], [18, 'Good'], [15, 'Average'], [13, 'Below Average']],
    '26-35': [[21, 'Excellent'], [17, 'Good'], [14, 'Average'], [11, 'Below Average']],
    '36-45': [[21, 'Excellent'], [16, 'Good'], [13, 'Average'], [11, 'Below Average']],
    '46-55': [[19, 'Excellent'], [14, 'Good'], [11, 'Average'], [9, 'Below Average']],
    '56-65': [[17, 'Excellent'], [13, 'Good'], [9, 'Average'], [7, 'Below Average']],
  },
  Female: {
    '18-25': [[24, 'Excellent'], [20, 'Good'], [18, 'Average'], [16, 'Below Average']],
    '26-35': [[23, 'Excellent'], [20, 'Good'], [17, 'Average'], [15, 'Below Average']],
    '36-45': [[22, 'Excellent'], [18, 'Good'], [16, 'Average'], [14, 'Below Average']],
    '46-55': [[21, 'Excellent'], [17, 'Good'], [14, 'Average'], [12, 'Below Average']],
    '56-65': [[20, 'Excellent'], [16, 'Good'], [14, 'Average'], [11, 'Below Average']],
  },
};

const SIT_AND_REACH_AGES = {
  '18-25': [18, 25], '26-35': [26, 35], '36-45': [36, 45], '46-55': [46, 55], '56-65': [56, 65],
};

const quadSide = (over = {}) => ({
  contact: true, distance_cm: null, pain: false, pelvic_compensation: false, tightness: 'Normal', notes: '', ...over,
});
const hamSide = (over = {}) => ({
  hip_flexion_deg: 75, knee_extended: true, pelvic_compensation: false, pain: false, tightness: 'Normal', notes: '', ...over,
});
const hipSide = (over = {}) => ({
  thigh_position: 'below', knee_flexion_deg: 30, pelvic_compensation: false, pain: false, tightness: 'Normal', notes: '', ...over,
});

function battery() {
  return {
    protocol_version: flexibility.PROTOCOL_VERSION,
    tests: {
      quadriceps: { sides: { left: quadSide(), right: quadSide() }, completed: true },
      hamstrings: { sides: { left: hamSide(), right: hamSide() }, completed: true },
      hip_flexors: { sides: { left: hipSide(), right: hipSide() }, completed: true },
      sit_and_reach: {
        attempts: [{ inches: 16, valid: true }], knee_bending: false, bouncing: false, notes: '', completed: true,
      },
    },
  };
}

describe('K11 VO2max norms', () => {
  for (const sex of SEXES) {
    for (const [row, norms] of Object.entries(VO2_NORMS[sex])) {
      for (const age of VO2_AGES[row]) {
        for (const [minimum, category] of norms) {
          test(`${sex} age ${age}: ${minimum} → ${category}`, () => {
            expect(fitness.classifyVo2Max(minimum, age, sex)).toBe(category);
          });
          test(`${sex} age ${age}: below ${minimum} is not ${category}`, () => {
            expect(fitness.classifyVo2Max(minimum - 0.1, age, sex)).not.toBe(category);
          });
        }
      }
    }
  }

  test('below the Poor floor is Very Poor', () => {
    expect(fitness.classifyVo2Max(10, 30, 'Male')).toBe('Very Poor');
    expect(fitness.classifyVo2Max(10, 30, 'Female')).toBe('Very Poor');
  });

  test('missing age or unsupported sex has no category', () => {
    expect(fitness.classifyVo2Max(45, null, 'Male')).toBeNull();
    expect(fitness.classifyVo2Max(45, 30, null)).toBeNull();
    expect(fitness.classifyVo2Max(45, 30, 'Other')).toBeNull();
    expect(fitness.classifyVo2Max(45, 14, 'Male')).toBeNull();
    expect(fitness.classifyVo2Max(0, 30, 'Male')).toBeNull();
  });
});

describe('K11 push-up norms', () => {
  for (const sex of SEXES) {
    for (const [band, norms] of Object.entries(PUSHUP_NORMS[sex])) {
      for (const age of PUSHUP_AGES[band]) {
        for (const [minimum, category] of norms) {
          test(`${sex} age ${age}: ${minimum} → ${category}`, () => {
            expect(fitness.classifyEndurance('Push Up Test', minimum, sex, age)).toBe(category);
          });
          test(`${sex} age ${age}: below ${minimum} is not ${category}`, () => {
            expect(fitness.classifyEndurance('Push Up Test', minimum - 1, sex, age)).not.toBe(category);
          });
        }
        test(`${sex} age ${age}: below the Fair floor is Poor`, () => {
          expect(fitness.classifyEndurance('Push Up Test', norms[norms.length - 1][0] - 1, sex, age)).toBe('Poor');
        });
      }
    }
  }

  test('outside 20–69, or without a usable sex/age, no category', () => {
    expect(fitness.classifyEndurance('Push Up Test', 30, 'Male', 19)).toBeNull();
    expect(fitness.classifyEndurance('Push Up Test', 30, 'Male', 70)).toBeNull();
    expect(fitness.classifyEndurance('Push Up Test', 30, 'Male', null)).toBeNull();
    expect(fitness.classifyEndurance('Push Up Test', 30, null, 30)).toBeNull();
    expect(fitness.classifyEndurance('Push Up Test', 0, 'Male', 30)).toBeNull();
  });
});

describe('K11 curl-up norms', () => {
  for (const sex of SEXES) {
    for (const [band, rows] of Object.entries(CURLUP_NORMS[sex])) {
      for (const age of PUSHUP_AGES[band]) {
        for (const [percentile, minimum] of rows) {
          // Two rows can share a floor (e.g. male 40–49 has 75 at the 90th
          // and 80th percentiles); the higher percentile owns that value.
          if (rows.find(([, m]) => m === minimum)[0] !== percentile) continue;
          // A zero result is "not performed", not a 20th-percentile score.
          if (minimum <= 0) continue;
          test(`${sex} age ${age}: ${minimum} reaches the ${percentile}th percentile`, () => {
            expect(fitness.classifyEndurance('Curl Up Test', minimum, sex, age)).toBe(CURLUP_CATEGORY[percentile]);
          });
        }
        const floor = rows[rows.length - 1][1];
        test(`${sex} age ${age}: below the 20th percentile is Well Below Average`, () => {
          expect(fitness.classifyEndurance('Curl Up Test', floor > 0 ? floor - 1 : 1, sex, age)).toBe('Well Below Average');
        });
      }
    }
  }

  test('outside 20–69, or without a usable sex/age, no category', () => {
    expect(fitness.classifyEndurance('Curl Up Test', 30, 'Male', 19)).toBeNull();
    expect(fitness.classifyEndurance('Curl Up Test', 30, 'Male', 70)).toBeNull();
    expect(fitness.classifyEndurance('Curl Up Test', 30, 'Male', null)).toBeNull();
    expect(fitness.classifyEndurance('Curl Up Test', 30, null, 30)).toBeNull();
    expect(fitness.classifyEndurance('Curl Up Test', 0, 'Male', 30)).toBeNull();
  });
});

describe('K11 muscular-endurance test scope', () => {
  test('plank, wall sit, bodyweight squat and custom have no supplied K11 norm', () => {
    expect(fitness.classifyEndurance('Plank', 90, null, 30)).toBeNull();
    expect(fitness.classifyEndurance('Wall Sit', 90, 'Male', 30)).toBeNull();
    expect(fitness.classifyEndurance('Bodyweight Squat', 30, 'Female', 30)).toBeNull();
    expect(fitness.classifyEndurance('Custom', 30, 'Female', 30)).toBeNull();
  });
});

describe('K11 sit-and-reach norms', () => {
  for (const sex of SEXES) {
    for (const [band, norms] of Object.entries(SIT_AND_REACH_NORMS[sex])) {
      for (const age of SIT_AND_REACH_AGES[band]) {
        for (const [minimum, category] of norms) {
          test(`${sex} age ${age}: ${minimum} in → ${category}`, () => {
            expect(fitness.classifySitAndReach(minimum, age, sex)).toBe(category);
          });
          test(`${sex} age ${age}: below ${minimum} in is not ${category}`, () => {
            expect(fitness.classifySitAndReach(minimum - 0.1, age, sex)).not.toBe(category);
          });
        }
        test(`${sex} age ${age}: below the lowest floor is Well Below Average`, () => {
          expect(fitness.classifySitAndReach(norms[norms.length - 1][0] - 1, age, sex)).toBe('Well Below Average');
        });
      }
    }
  }

  test('outside 18–65, or without a usable sex/age, no category', () => {
    expect(fitness.classifySitAndReach(20, 17, 'Male')).toBeNull();
    expect(fitness.classifySitAndReach(20, 66, 'Male')).toBeNull();
    expect(fitness.classifySitAndReach(20, null, 'Male')).toBeNull();
    expect(fitness.classifySitAndReach(20, 30, null)).toBeNull();
    expect(fitness.classifySitAndReach(20, 30, 'Other')).toBeNull();
    expect(fitness.classifySitAndReach(-1, 30, 'Male')).toBeNull();
  });
});

describe('K11 body-fat ideal', () => {
  test('male ideal is <=15%, female <=20%, with no lower-bound penalty', () => {
    expect(fitness.scoreBodyComposition(15, 'Male')).toBe(100);
    expect(fitness.scoreBodyComposition(16, 'Male')).toBe(96);
    expect(fitness.scoreBodyComposition(25, 'Male')).toBe(60);
    expect(fitness.scoreBodyComposition(5, 'Male')).toBe(100);
    expect(fitness.scoreBodyComposition(20, 'Female')).toBe(100);
    expect(fitness.scoreBodyComposition(21, 'Female')).toBe(96);
    expect(fitness.scoreBodyComposition(25, 'Female')).toBe(80);
    expect(fitness.scoreBodyComposition(5, 'Female')).toBe(100);
  });

  test('missing or unsupported sex still has no score', () => {
    expect(fitness.scoreBodyComposition(15, null)).toBeNull();
    expect(fitness.scoreBodyComposition(15, 'Other')).toBeNull();
  });
});

describe('K11 flexibility battery norm', () => {
  test('derives the sit-and-reach category when age and sex are known', () => {
    const d = flexibility.deriveFlexibility(battery(), { age: 30, gender: 'Male' });
    expect(d.tests.sit_and_reach.norm.category).toBe('Average');
    expect(d.tests.sit_and_reach.norm.table_version).toBeTruthy();
    expect(d.tests.sit_and_reach.norm.message).toMatch(/K11/);
  });

  test('without context the norm is unavailable, but a stored norm is preserved', () => {
    const noContext = flexibility.deriveFlexibility(battery());
    expect(noContext.tests.sit_and_reach.norm.category).toBeNull();

    const storedNorm = { table_version: 'k11-sit-and-reach', category: 'Good', message: 'Stored K11 norm' };
    const stored = battery();
    stored.tests.sit_and_reach.norm = storedNorm;
    expect(flexibility.deriveFlexibility(stored).tests.sit_and_reach.norm).toEqual(storedNorm);
  });
});

describe('K11 formula bundle', () => {
  test('version 5', () => {
    expect(fitness.FITNESS_SCORING_VERSION).toBe('5');
  });
});
