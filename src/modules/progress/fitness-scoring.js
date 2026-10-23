// src/modules/progress/fitness-scoring.js
// Pure calculation/classification functions for the Fitness Testing module.
// Backend twin of 619-erp-frontend/src/lib/fitness-calculations.ts — same
// formulas, duplicated deliberately since there's no shared package between
// the two apps. Scores/categories are always computed here (server-side),
// never trusted from client-submitted values.
//
// Formula-bundle version. Bump whenever any formula in this module changes.
// Persisting it per assessment requires the approval-gated migration described
// in F10 (new nullable `scoring_formula_version` column on pt_assessments);
// until then this is documentation only and legacy rows are treated as unknown.
const FITNESS_SCORING_VERSION = '5';

function round(n, decimals = 1) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ── Step 1: Vitals ─────────────────────────────────────────
// AHA blood-pressure bands plus resting heart rate and SpO₂. Classification is
// clinical description only; the exercise-safety decision lives in
// assessVitalsSafety below. A single reading is never a diagnosis.
function classifyBp(systolic, diastolic) {
  if (systolic == null && diastolic == null) return null;
  // Highest-risk band wins when the two numbers disagree: 185/70 is crisis,
  // 160/58 is stage 2, 135/55 is hypotension.
  if ((systolic != null && systolic >= 180) || (diastolic != null && diastolic >= 120)) return 'Hypertensive Crisis';
  if ((systolic != null && systolic >= 140) || (diastolic != null && diastolic >= 90)) return 'Hypertension Stage 2';
  if ((systolic != null && systolic < 90) || (diastolic != null && diastolic < 60)) return 'Hypotension';
  if ((systolic != null && systolic >= 130) || (diastolic != null && diastolic >= 80)) return 'Hypertension Stage 1';
  // One number cannot establish "normal": only the high bands are safe to
  // name from a single systolic value.
  if (systolic != null && systolic >= 120 && (diastolic == null || diastolic < 80)) return 'Elevated';
  if (systolic == null || diastolic == null) return null;
  return 'Normal';
}

// Preferred adult resting range is 60–80 bpm (average ~72); 60–100 is the
// broader adult reference. A low reading is described, not diagnosed.
function classifyRhr(rhr) {
  if (rhr == null || !Number.isFinite(rhr)) return null;
  if (rhr < 60) return 'Low';
  if (rhr <= 80) return 'Normal';
  if (rhr <= 100) return 'High Normal';
  return 'High';
}

function classifySpo2(spo2) {
  if (spo2 == null || !Number.isFinite(spo2)) return null;
  if (spo2 < 90) return 'Critical';
  if (spo2 < 95) return 'Mildly Low';
  return 'Normal';
}

/** The exercise-safety decision, separate from the clinical labels above.
 *  `stop` means no cardio, strength or endurance test today. `caution` means
 *  the test may proceed after rest/recheck. */
function assessVitalsSafety(v) {
  const reasons = [];
  let level = 'safe';
  const stop = (reason) => { level = 'stop'; reasons.push(reason); };
  const caution = (reason) => {
    if (level !== 'stop') level = 'caution';
    reasons.push(reason);
  };

  const bp = classifyBp(v.systolic, v.diastolic);
  const bpKnown = v.systolic != null || v.diastolic != null;
  if (bp === 'Hypertensive Crisis') {
    stop('Blood pressure is in the hypertensive crisis range (≥180/120 mmHg). Stop testing and arrange urgent medical assessment.');
  } else if (bp === 'Hypertension Stage 2') {
    stop('Blood pressure is at hypertension stage 2 (≥140/90 mmHg). Exertion testing requires medical clearance.');
  } else if (bp === 'Hypotension') {
    stop('Blood pressure is low (<90/60 mmHg). Exertion testing requires medical clearance.');
  } else if (bp === 'Hypertension Stage 1') {
    caution('Blood pressure is at hypertension stage 1 (130–139/80–89 mmHg). Rest 5–10 minutes and recheck before exertion testing.');
  } else if (bp === 'Elevated') {
    caution('Blood pressure is elevated (120–129/<80 mmHg). Rest 5–10 minutes and recheck.');
  }

  const rhr = classifyRhr(v.restingHeartRate);
  if (rhr === 'High') {
    stop('Resting heart rate is above 100 bpm. Do not start exertion testing; reassess and refer if it persists.');
  } else if (rhr === 'Low') {
    if (v.restingHeartRate != null && v.restingHeartRate < 40) {
      stop('Resting heart rate is below 40 bpm. Do not start exertion testing without medical review.');
    } else if (!v.athlete) {
      caution('Resting heart rate is below 60 bpm. Confirm the client is well; for a trained athlete this can be normal.');
    }
  } else if (rhr === 'High Normal') {
    caution('Resting heart rate is 81–100 bpm. Recheck after 5 minutes of rest.');
  }

  const spo2 = classifySpo2(v.restingSpo2);
  if (spo2 === 'Critical') {
    stop('Resting SpO₂ is below 90%. Do not start exertion testing; seek medical assessment.');
  } else if (spo2 === 'Mildly Low') {
    caution('Resting SpO₂ is 90–94%. Recheck after rest and monitor for breathlessness.');
  }

  return {
    level,
    reasons,
    requiresMedicalClearance: level === 'stop',
    repeatBp: bpKnown && bp !== 'Normal',
    athleteLowRhr: Boolean(v.athlete) && rhr === 'Low' && (v.restingHeartRate ?? 0) >= 40,
  };
}

// ── Step 2: Anthropometric ──────────────────────────────────
function calcBmi(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const heightM = heightCm / 100;
  return round(weightKg / (heightM * heightM), 1);
}

function calcWhr(waistCm, hipsCm) {
  if (!waistCm || !hipsCm) return null;
  return round(waistCm / hipsCm, 2);
}

// MPTS adult Asian BMI bands.
function classifyBmi(bmi) {
  if (bmi == null || !Number.isFinite(bmi) || bmi <= 0) return null;
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 23) return 'Normal';
  if (bmi < 25) return 'Overweight';
  return 'Obese';
}

// The published waist and WHR norms define only the low-risk side. A reading
// at or above the cut-off is described as such — never promoted to an invented
// "moderate" or "high" risk band.
//
// Waist circumference is the narrowest-waist measurement (`waist_cm`), the
// same field the WHR formula uses. The iliac-crest measurement is a separate
// landmark and is never substituted when `waist_cm` is missing.
const WAIST_LOW_RISK_CM = { Male: 90, Female: 80 };
const WHR_LOW_RISK = { Male: 0.95, Female: 0.86 };

function classifyWaistRisk(waistCm, gender) {
  if (waistCm == null || !Number.isFinite(waistCm) || waistCm <= 0) return null;
  const g = sexOf(gender);
  if (!g) return null;
  return waistCm < WAIST_LOW_RISK_CM[g] ? 'Low risk' : 'Above low-risk threshold';
}

function classifyWhrRisk(whr, gender) {
  if (whr == null || !Number.isFinite(whr) || whr <= 0) return null;
  const g = sexOf(gender);
  if (!g) return null;
  return whr < WHR_LOW_RISK[g] ? 'Low risk' : 'Above low-risk threshold';
}

// ── Step 3: Body Composition ────────────────────────────────
// Mifflin-St Jeor (1990).
function calcBmr(weightKg, heightCm, age, gender) {
  if (!weightKg || !heightCm || !age || !gender) return null;
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(gender === 'Male' ? base + 5 : base - 161);
}

function calcLeanBodyMass(weightKg, bodyFatPct) {
  if (!weightKg || bodyFatPct == null) return null;
  return round(weightKg * (1 - bodyFatPct / 100), 2);
}

function calcFatMass(weightKg, bodyFatPct) {
  if (!weightKg || bodyFatPct == null) return null;
  return round(weightKg * (bodyFatPct / 100), 2);
}

// ── Step 4: Cardiorespiratory Endurance ─────────────────────
// Kline et al. (1987) — Rockport 1-Mile Walk Test.
function calcVo2MaxRockport(weightKg, age, gender, timeMin, heartRate) {
  if (!weightKg || !age || !timeMin || !heartRate) return null;
  const weightLb = weightKg * 2.20462;
  const genderTerm = gender === 'Male' ? 1 : 0;
  const vo2 = 132.853 - 0.0769 * weightLb - 0.3877 * age + 6.315 * genderTerm - 3.2649 * timeMin - 0.1565 * heartRate;
  return round(vo2, 2);
}

// Cooper (1968) — 12-Minute Run Test.
function calcVo2MaxCooper(distanceMeters) {
  if (!distanceMeters) return null;
  return round((distanceMeters - 504.9) / 44.73, 2);
}

// Foster et al. (1984) — Bruce Protocol treadmill-time estimate.
function calcVo2MaxBruce(treadmillMinutes) {
  if (!treadmillMinutes) return null;
  const t = treadmillMinutes;
  return round(14.8 - 1.379 * t + 0.451 * t * t - 0.012 * t * t * t, 2);
}

// Harvard Step Test — Physical Efficiency Index (long form).
// Classified directly; no VO2max output.
function calcHarvardPei(durationSec, pulse1, pulse2, pulse3) {
  if (!durationSec || !pulse1 || !pulse2 || !pulse3) return null;
  return round((durationSec * 100) / (2 * (pulse1 + pulse2 + pulse3)), 1);
}


// 'Male' / 'Female' in any case, or null. Norm tables are split by sex, and
// anything else — null, 'Other', a lowercase 'male' from an older caller —
// used to fall through to the FEMALE table and produce a confident category
// from the wrong norms. No sex, no sex-split category.
function sexOf(gender) {
  const v = typeof gender === 'string' ? gender.trim().toLowerCase() : '';
  return v === 'male' ? 'Male' : v === 'female' ? 'Female' : null;
}

function classifyHarvardPei(pei) {
  if (pei == null) return null;
  // Published long-form fitness-index bands: <55 poor, 55–64 low average,
  // 65–79 average, 80–89 good, 90+ excellent. The old cut-offs sat one band
  // high — an 85 read "Average" instead of "Good".
  if (pei < 55) return 'Poor';
  if (pei < 65) return 'Below Average';
  if (pei < 80) return 'Average';
  if (pei < 90) return 'Good';
  return 'Excellent';
}

// K11 age-adjusted VO2max norms (mL/kg/min), by sex and five-year age band.
// Each row is [minimum, category], highest category first; below the Poor floor
// is Very Poor. The 65+ row is the last supplied band, so it also applies to
// older clients. Male 65 uses 46–42: the source prints 48–42, which overlaps
// the Superior floor and is a typo, not a second band.
const K11_VO2_NORMS = {
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

/** The K11 row for an age at the test; under 15 has no supplied norm. */
function vo2AgeRow(age) {
  if (age == null || !Number.isFinite(age) || age < 15) return null;
  if (age >= 65) return 65;
  return Math.floor(age / 5) * 5;
}

function classifyVo2Max(vo2, age, gender) {
  if (vo2 == null || !Number.isFinite(vo2) || vo2 <= 0) return null;
  const g = sexOf(gender);
  const row = vo2AgeRow(age);
  if (!g || row == null) return null;
  for (const [minimum, category] of K11_VO2_NORMS[g][row]) {
    if (vo2 >= minimum) return category;
  }
  return 'Very Poor';
}

// YMCA 3-Minute Step Test. K11 publishes recovery heart-rate norms by age and
// sex for ages 18–55 only, with no VO2max conversion. Bands below are the
// published whole-bpm ranges, written as closed integer intervals exactly as
// printed: `<79` becomes 40–78, `79–89` stays 79–89, and male `>128` becomes
// 129–220 (the physiological guard). Two source gaps are preserved rather than
// papered over:
//   • female tables print no Very Poor row, so values above the Poor ceiling
//     (140 / 138 / 140 / 135 by age group) return no category;
//   • the female 46–55 row jumps from "Excellent <94" to "Good 95–104", so
//     94 bpm is in neither band and returns no category.
// A non-integer reading is not one of the published whole-bpm bands either.
const YMCA_STEP_RECOVERY_NORMS = {
  Male: {
    '18-25': [
      ['Excellent', 40, 78], ['Good', 79, 89], ['Above Average', 90, 99],
      ['Average', 100, 105], ['Below Average', 106, 116], ['Poor', 117, 128],
      ['Very Poor', 129, 220],
    ],
    '26-35': [
      ['Excellent', 40, 80], ['Good', 81, 89], ['Above Average', 90, 99],
      ['Average', 100, 107], ['Below Average', 108, 117], ['Poor', 118, 128],
      ['Very Poor', 129, 220],
    ],
    '36-45': [
      ['Excellent', 40, 82], ['Good', 83, 96], ['Above Average', 97, 103],
      ['Average', 104, 112], ['Below Average', 113, 119], ['Poor', 120, 130],
      ['Very Poor', 131, 220],
    ],
    '46-55': [
      ['Excellent', 40, 86], ['Good', 87, 97], ['Above Average', 98, 105],
      ['Average', 106, 116], ['Below Average', 117, 122], ['Poor', 123, 132],
      ['Very Poor', 133, 220],
    ],
  },
  Female: {
    '18-25': [
      ['Excellent', 40, 84], ['Good', 85, 98], ['Above Average', 99, 108],
      ['Average', 109, 117], ['Below Average', 118, 126], ['Poor', 127, 140],
    ],
    '26-35': [
      ['Excellent', 40, 87], ['Good', 88, 99], ['Above Average', 100, 111],
      ['Average', 112, 119], ['Below Average', 120, 126], ['Poor', 127, 138],
    ],
    '36-45': [
      ['Excellent', 40, 89], ['Good', 90, 102], ['Above Average', 103, 110],
      ['Average', 111, 118], ['Below Average', 119, 128], ['Poor', 129, 140],
    ],
    '46-55': [
      ['Excellent', 40, 93], ['Good', 95, 104], ['Above Average', 105, 115],
      ['Average', 116, 120], ['Below Average', 121, 126], ['Poor', 127, 135],
    ],
  },
};

function recoveryAgeGroup(age) {
  // The published bands are whole-year ranges; a fractional age is not in one.
  if (age == null || !Number.isInteger(age)) return null;
  if (age >= 18 && age <= 25) return '18-25';
  if (age >= 26 && age <= 35) return '26-35';
  if (age >= 36 && age <= 45) return '36-45';
  if (age >= 46 && age <= 55) return '46-55';
  return null;
}

function classifyStepTestRecovery(recoveryHr, age, gender) {
  // Implausible recovery heart rate (not a real measurement) must not produce
  // a category — guard the physiological range.
  if (recoveryHr == null || !Number.isFinite(recoveryHr) || recoveryHr < 40 || recoveryHr > 220) return null;
  const g = sexOf(gender);
  const group = recoveryAgeGroup(age);
  if (!g || !group) return null;
  for (const [category, min, max] of YMCA_STEP_RECOVERY_NORMS[g][group]) {
    if (recoveryHr >= min && recoveryHr <= max) return category;
  }
  return null;
}

// ── Step 5: Muscular Strength ───────────────────────────────
function calc1RM(weightKg, reps, formula) {
  if (!weightKg || !reps) return null;
  if (formula === 'brzycki') {
    const clampedReps = Math.min(reps, 12);
    return round(weightKg * 36 / (37 - clampedReps), 1);
  }
  // Epley (1985) — default. A single IS the 1RM: the formula would add 3.3%
  // to it (w × 31/30) and credit a lift nobody made.
  if (reps === 1) return round(weightKg, 1);
  return round(weightKg * (1 + reps / 30), 1);
}

// K11 relative-strength norms: 1RM ÷ body weight, by sex, exercise and the
// age at the test. Each row is [percentile, minimum ratio]; a ratio at or above
// the minimum belongs to that percentile. Values supplied exactly as given.
//
// Only Bench Press (upper body) and Leg Press (lower body) have supplied K11
// tables. K11 names Squat as an alternative lower-body test but supplies no
// Squat percentiles, and Deadlift / Shoulder Press have none either — those
// lifts therefore get no K11 category rather than borrowed Leg Press or
// bench-press thresholds.
const K11_STRENGTH_NORMS = {
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
    // The supplied female tables stop at the 20th percentile. No 10th-percentile
    // row is invented; a lower ratio is reported as below the supported range.
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

const K11_PERCENTILE_CATEGORY = {
  90: 'Well Above Average', 80: 'Well Above Average',
  70: 'Above Average', 60: 'Above Average',
  50: 'Average',
  40: 'Below Average', 30: 'Below Average',
  20: 'Well Below Average', 10: 'Well Below Average',
};

/** The K11 age band at the time of testing. Under 20 has no supplied norms. */
function strengthAgeBand(age) {
  if (age == null || !Number.isFinite(age) || age < 20) return null;
  if (age < 30) return '20-29';
  if (age < 40) return '30-39';
  if (age < 50) return '40-49';
  if (age < 60) return '50-59';
  return '60+';
}

/**
 * Full K11 classification, keeping the percentile separate from the category.
 * Returns null when any input needed to pick a table is missing or invalid —
 * a missing age, an unsupported sex, or a zero/negative/non-finite 1RM or body
 * weight must not produce a confident category.
 */
function classifyStrengthDetail(oneRM, bodyWeightKg, exercise, gender, age) {
  if (oneRM == null || !Number.isFinite(oneRM) || oneRM <= 0) return null;
  if (bodyWeightKg == null || !Number.isFinite(bodyWeightKg) || bodyWeightKg <= 0) return null;
  const g = sexOf(gender);
  if (!g) return null;
  if (exercise !== 'Bench Press' && exercise !== 'Leg Press') return null;
  const ageBand = strengthAgeBand(age);
  if (!ageBand) return null;
  const ratio = oneRM / bodyWeightKg;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const roundedRatio = round(ratio, 2);

  for (const [percentile, minimum] of K11_STRENGTH_NORMS[g][exercise][ageBand]) {
    if (ratio >= minimum) {
      return { category: K11_PERCENTILE_CATEGORY[percentile], percentile, ratio: roundedRatio, ageBand };
    }
  }
  // Below every supplied row: say exactly that, with no fabricated percentile.
  return { category: 'Below Supported Range', percentile: null, ratio: roundedRatio, ageBand };
}

/** The stored/scored category only. `age` is the age at the time of testing. */
function classifyStrength(oneRM, bodyWeightKg, exercise, gender, age) {
  const detail = classifyStrengthDetail(oneRM, bodyWeightKg, exercise, gender, age);
  return detail ? detail.category : null;
}

// ── Step 6: Muscular Endurance ──────────────────────────────
// K11 supplies age- and sex-specific tables for the push-up and curl-up only.
// Plank, wall sit, bodyweight squat and custom have no supplied K11 norm, so
// they return null rather than borrowing another test's thresholds.
const K11_PUSHUP_NORMS = {
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

// Each row is [percentile, minimum repetitions], highest percentile first.
const K11_CURLUP_NORMS = {
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

const K11_CURLUP_PERCENTILE_CATEGORY = {
  90: 'Well Above Average', 80: 'Above Average',
  60: 'Average', 50: 'Average',
  40: 'Below Average', 20: 'Well Below Average',
};

function enduranceAgeBand(age) {
  if (age == null || !Number.isFinite(age)) return null;
  const whole = Math.floor(age);
  if (whole < 20 || whole > 69) return null;
  const start = Math.floor(whole / 10) * 10;
  return `${start}-${start + 9}`;
}

/**
 * K11 endurance category. `age` is the age at the time of testing; missing age
 * or sex means no category, never a default row.
 */
function classifyEndurance(testType, value, gender, age) {
  // A zero or negative result is not a performed test — never classify it as
  // "Poor" (20), which would masquerade as a real (bad) score.
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const g = sexOf(gender);
  const band = enduranceAgeBand(age);
  if (!g || !band) return null;
  if (testType === 'Push Up Test') {
    for (const [minimum, category] of K11_PUSHUP_NORMS[g][band]) {
      if (value >= minimum) return category;
    }
    return 'Poor';
  }
  if (testType === 'Curl Up Test') {
    for (const [percentile, minimum] of K11_CURLUP_NORMS[g][band]) {
      if (value >= minimum) return K11_CURLUP_PERCENTILE_CATEGORY[percentile];
    }
    return 'Well Below Average';
  }
  return null;
}

// ── Step 7: Flexibility ─────────────────────────────────────
// K11 YMCA sit-and-reach table, in raw inches. Each row is
// [minimum printed range value, category], highest first; below the lowest
// floor is Well Below Average. The source prints integer ranges with gaps, so
// the minimum of each printed range is used as that category's floor.
const K11_SIT_AND_REACH_TABLE_VERSION = 'k11-2026.01-sit-and-reach';
const K11_SIT_AND_REACH_NORMS = {
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

function sitAndReachAgeBand(age) {
  if (age == null || !Number.isFinite(age)) return null;
  const whole = Math.floor(age);
  if (whole < 18 || whole > 65) return null;
  if (whole <= 25) return '18-25';
  if (whole <= 35) return '26-35';
  if (whole <= 45) return '36-45';
  if (whole <= 55) return '46-55';
  return '56-65';
}

function classifySitAndReach(inches, age, gender) {
  if (inches == null || !Number.isFinite(inches) || inches < 0) return null;
  const g = sexOf(gender);
  const band = sitAndReachAgeBand(age);
  if (!g || !band) return null;
  for (const [minimum, category] of K11_SIT_AND_REACH_NORMS[g][band]) {
    if (inches >= minimum) return category;
  }
  return 'Well Below Average';
}

// ── Flexibility composite / asymmetry ───────────────────────
function checkAsymmetry(left, right, thresholdPct = 10) {
  if (left == null || right == null) return false;
  const max = Math.max(Math.abs(left), Math.abs(right));
  if (max === 0) return false;
  return (Math.abs(left - right) / max) * 100 > thresholdPct;
}

function classifyFlexibilityScore(score) {
  // score expected 0-10 (trainer-entered subjective/measured composite). Out-of-
  // range or non-finite input is not a score — never classify it, so a 25
  // cannot masquerade as "Excellent" (95). 0 is legitimate ("very limited").
  if (score == null || !Number.isFinite(score) || score < 0 || score > 10) return null;
  if (score >= 8) return 'Excellent';
  if (score >= 6) return 'Good';
  if (score >= 4) return 'Average';
  if (score >= 2) return 'Below Average';
  return 'Poor';
}

// ── Category → score mapping (used consistently across Cardio/
//    Endurance/Mobility/Strength for the 0-100 dashboard scores) ──
const CATEGORY_SCORES = {
  Superior: 100, Excellent: 95, 'Very Good': 85, Good: 80, Fair: 50,
  'Well Above Average': 90, 'Above Average': 70, Average: 60, 'Below Average': 40,
  'Well Below Average': 20, 'Below Supported Range': 20,
  Poor: 20, 'Very Poor': 10,
};
function scoreCategory(category) {
  return CATEGORY_SCORES[category] ?? null;
}

// Body Composition Score: K11 gives an upper bound only — 100 at or below 15%
// for men and 20% for women, then four points off per percentage point above
// it. No lower-bound penalty is invented where K11 supplies none. Returns null
// when gender is missing or 'Other' — no sex-neutral reference exists.
const K11_IDEAL_BODY_FAT_MAX = { Male: 15, Female: 20 };
function scoreBodyComposition(bodyFatPct, gender) {
  if (bodyFatPct == null || !Number.isFinite(bodyFatPct)) return null;
  const g = sexOf(gender);
  if (!g) return null;
  const max = K11_IDEAL_BODY_FAT_MAX[g];
  if (bodyFatPct <= max) return 100;
  return Math.max(0, Math.round(100 - (bodyFatPct - max) * 4));
}

// Health Score (stored column `health_risk_score`): average of a BP-category
// subscore and a BMI-category subscore. Higher is better — 100 is normal BP
// within the healthy BMI band — same direction as the other five axes. BP bands
// follow AHA BP categories.
//
// The BMI bands below are deliberately NOT the MPTS/Asian anthropometric
// categories in classifyBmi(): they are the pre-existing project risk proxy,
// left unchanged so stored Health Scores stay comparable. A BMI of 23–24.9 is
// therefore "Overweight" in the anthropometric block while this score still
// treats 18.5–<25 as healthy. This divergence is documented and pinned by a
// regression test; do not silently reconcile it here.
//
// Healthy 100, overweight/underweight 60, obese 30 — no separate underweight
// penalty. Discontinuity: 24.9 → 100, 25.0 → 60.
const BP_RISK_SCORE = { Normal: 100, Elevated: 80, 'Hypertension Stage 1': 55, 'Hypertension Stage 2': 20, 'Hypertensive Crisis': 5, Hypotension: 40 };
function scoreBmiRisk(bmi) {
  if (bmi == null) return null;
  if (bmi >= 18.5 && bmi < 25) return 100;
  if (bmi < 18.5) return 60;
  if (bmi < 30) return 60;
  return 30;
}
function scoreHealthRisk(bpCategory, bmi) {
  const bpScore = BP_RISK_SCORE[bpCategory] ?? null;
  const bmiScore = scoreBmiRisk(bmi);
  const scores = [bpScore, bmiScore].filter((s) => s != null);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// Combined Muscular Endurance score: average of the two required tests'
// sub-scores (same averaging pattern as scoreHealthRisk above).
function scoreEnduranceBattery(score1, score2) {
  const scores = [score1, score2].filter((s) => s != null);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function computeOverallScore(scores) {
  const vals = Object.values(scores).filter((v) => v != null);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

module.exports = {
  FITNESS_SCORING_VERSION,
  classifyBp,
  classifyRhr,
  classifySpo2,
  assessVitalsSafety,
  calcBmi,
  calcWhr,
  classifyBmi,
  classifyWaistRisk,
  classifyWhrRisk,
  calcBmr,
  calcLeanBodyMass,
  calcFatMass,
  calcVo2MaxRockport,
  calcVo2MaxCooper,
  calcVo2MaxBruce,
  calcHarvardPei,
  classifyHarvardPei,
  classifyVo2Max,
  classifyStepTestRecovery,
  calc1RM,
  classifyStrength,
  classifyStrengthDetail,
  strengthAgeBand,
  classifyEndurance,
  K11_SIT_AND_REACH_TABLE_VERSION,
  classifySitAndReach,
  checkAsymmetry,
  classifyFlexibilityScore,
  scoreCategory,
  scoreBodyComposition,
  scoreHealthRisk,
  scoreEnduranceBattery,
  computeOverallScore,
};
