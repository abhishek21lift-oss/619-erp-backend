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
const FITNESS_SCORING_VERSION = '4';

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

// Simplified gender-split, 3-age-band VO2max norms (mL/kg/min).
// Simplification vs. full per-decade Cooper Institute tables — Phase 1
// deliberately trades precision for a small, maintainable table.
//
// SOURCE GAP — K11's VO2max table uses Superior / Excellent / Very Good / Good
// / Fair / Poor / Very Poor, but the K11 threshold values are not available
// here. These bands are an existing NON-K11 reference, shared by Rockport,
// Cooper and Bruce results; do not describe them as K11-approved until the
// missing table is sourced.
const VO2_MAX_NORMS = {
  Male:   { young: [42, 37, 33, 28], mid: [39, 34, 30, 25], senior: [35, 30, 26, 21] },
  Female: { young: [37, 32, 28, 23], mid: [34, 29, 25, 20], senior: [30, 25, 21, 16] },
};
function ageBand(age) {
  if (age < 30) return 'young';
  if (age < 50) return 'mid';
  return 'senior';
}
function classifyVo2Max(vo2, age, gender) {
  if (vo2 == null || !Number.isFinite(vo2) || vo2 <= 0) return null;
  const g = sexOf(gender);
  if (!g) return null;
  const [excellent, good, average, belowAverage] = VO2_MAX_NORMS[g][ageBand(age || 30)];
  if (vo2 >= excellent) return 'Excellent';
  if (vo2 >= good) return 'Good';
  if (vo2 >= average) return 'Average';
  if (vo2 >= belowAverage) return 'Below Average';
  return 'Poor';
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
// Single-scale, gender-split thresholds (no age bands) — Phase 1 simplification.
const PUSHUP_NORMS = { Male: [36, 29, 22, 17], Female: [30, 21, 15, 10] };
const CURLUP_NORMS = { Male: [40, 30, 20, 10], Female: [35, 25, 15, 8] };
const PLANK_NORMS_SEC = [120, 60, 30, 15]; // single scale, no standard gender norm

function classifyEndurance(testType, value, gender) {
  // A zero or negative result is not a performed test — never classify it as
  // "Poor" (20), which would masquerade as a real (bad) score.
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const g = sexOf(gender);
  let thresholds;
  // Plank norms are a single scale; the others are split by sex.
  if (testType === 'Plank') thresholds = PLANK_NORMS_SEC;
  else if (!g) return null;
  else if (testType === 'Push Up Test') thresholds = PUSHUP_NORMS[g];
  else if (testType === 'Curl Up Test') thresholds = CURLUP_NORMS[g];
  // Wall Sit, Bodyweight Squat and Custom have no norms here; plank norms
  // applied to them were an invented category.
  else return null;
  const [excellent, good, average, belowAverage] = thresholds;
  if (value >= excellent) return 'Excellent';
  if (value >= good) return 'Good';
  if (value >= average) return 'Average';
  if (value >= belowAverage) return 'Below Average';
  return 'Poor';
}

// ── Step 7: Flexibility ─────────────────────────────────────
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
  Excellent: 95, Good: 80,
  'Well Above Average': 90, 'Above Average': 70, Average: 60, 'Below Average': 40,
  'Well Below Average': 20, 'Below Supported Range': 20,
  Poor: 20, 'Very Poor': 10,
};
function scoreCategory(category) {
  return CATEGORY_SCORES[category] ?? null;
}

// Body Composition Score: 100 within a gender-specific "ideal" body-fat
// range, linear falloff outside it. Returns null when gender is missing or
// 'Other' — there is no sex-neutral reference range, so no score is invented.
const IDEAL_BODY_FAT = { Male: [10, 20], Female: [18, 28] };
function scoreBodyComposition(bodyFatPct, gender) {
  if (bodyFatPct == null) return null;
  const g = sexOf(gender);
  if (!g) return null;
  const [low, high] = IDEAL_BODY_FAT[g];
  if (bodyFatPct >= low && bodyFatPct <= high) return 100;
  const distance = bodyFatPct < low ? low - bodyFatPct : bodyFatPct - high;
  return Math.max(0, Math.round(100 - distance * 4));
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
  checkAsymmetry,
  classifyFlexibilityScore,
  scoreCategory,
  scoreBodyComposition,
  scoreHealthRisk,
  scoreEnduranceBattery,
  computeOverallScore,
};
