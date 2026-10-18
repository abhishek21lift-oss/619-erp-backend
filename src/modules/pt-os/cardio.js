'use strict';

function calcHrr(maxHeartRate, restingHeartRate) {
  if (!Number.isFinite(maxHeartRate) || !Number.isFinite(restingHeartRate)) return null;
  if (maxHeartRate <= 0 || restingHeartRate < 0) return null;
  if (restingHeartRate >= maxHeartRate) return null;
  return maxHeartRate - restingHeartRate;
}

function calcTargetHeartRate(maxHeartRate, restingHeartRate, intensityFraction) {
  const hrr = calcHrr(maxHeartRate, restingHeartRate);
  if (hrr == null) return null;
  if (!Number.isFinite(intensityFraction) || intensityFraction < 0 || intensityFraction > 1) return null;
  return Math.round(hrr * intensityFraction + restingHeartRate);
}

function calcTargetHeartRateRange(maxHeartRate, restingHeartRate, minFraction, maxFraction) {
  const min = calcTargetHeartRate(maxHeartRate, restingHeartRate, minFraction);
  const max = calcTargetHeartRate(maxHeartRate, restingHeartRate, maxFraction);
  if (min == null || max == null) return null;
  if (min > max) return { min: max, max: min };
  return { min, max };
}

function estimateMaxHeartRate(age) {
  if (!Number.isFinite(age) || age <= 0 || age > 120) return null;
  return 220 - age;
}

const CARDIO_MODALITY_CATEGORY = {
  running: 'weight-bearing-high-impact',
  jogging: 'weight-bearing-high-impact',
  sprinting: 'weight-bearing-high-impact',
  elliptical: 'weight-bearing-low-impact',
  walking: 'weight-bearing-low-impact',
  hiking: 'weight-bearing-low-impact',
  cycling: 'non-weight-bearing',
  rowing: 'non-weight-bearing',
  swimming: 'non-weight-bearing',
};

function classifyCardioModality(modality) {
  if (!modality) return null;
  const key = String(modality).trim().toLowerCase();
  if (CARDIO_MODALITY_CATEGORY[key]) return CARDIO_MODALITY_CATEGORY[key];
  if (/run|jog|sprint|jump/.test(key)) return 'weight-bearing-high-impact';
  if (/walk|ellipt|hike|stair/.test(key)) return 'weight-bearing-low-impact';
  if (/cycl|row|swim|bike/.test(key)) return 'non-weight-bearing';
  return null;
}

const FIVE_PHASE_DEFAULTS = [
  { name: 'General Warm-up', durationMinutes: 5, intensityFraction: 0.4 },
  { name: 'Re-warm-up / Specific Prep', durationMinutes: 3, intensityFraction: 0.5 },
  { name: 'Work Phase', durationMinutes: 20, intensityFraction: 0.7 },
  { name: 'Cool-down', durationMinutes: 5, intensityFraction: 0.4 },
  { name: 'Static Stretching', durationMinutes: 5, intensityFraction: 0.3 },
];

function buildCardioSession(maxHeartRate, restingHeartRate, phases) {
  if (!Number.isFinite(maxHeartRate) || !Number.isFinite(restingHeartRate)) return null;
  if (maxHeartRate <= 0 || restingHeartRate < 0 || restingHeartRate >= maxHeartRate) return null;
  const out = [];
  let total = 0;
  for (const p of phases) {
    if (!p || !Number.isFinite(p.durationMinutes) || p.durationMinutes < 0) return null;
    let thr = null;
    let range = null;
    if (p.intensityFraction != null) thr = calcTargetHeartRate(maxHeartRate, restingHeartRate, p.intensityFraction);
    if (p.minFraction != null && p.maxFraction != null) range = calcTargetHeartRateRange(maxHeartRate, restingHeartRate, p.minFraction, p.maxFraction);
    out.push({ name: p.name, durationMinutes: p.durationMinutes, intensityFraction: p.intensityFraction ?? null, targetHeartRate: thr, targetHeartRateRange: range, notes: p.notes });
    total += p.durationMinutes;
  }
  return { phases: out, totalMinutes: total };
}

function buildFivePhaseCardio(maxHeartRate, restingHeartRate, overrides) {
  const phases = FIVE_PHASE_DEFAULTS.map((base) => {
    const ov = (overrides && overrides[base.name]) || {};
    return { name: base.name, durationMinutes: ov.durationMinutes != null ? ov.durationMinutes : base.durationMinutes, intensityFraction: ov.intensityFraction != null ? ov.intensityFraction : base.intensityFraction };
  });
  return buildCardioSession(maxHeartRate, restingHeartRate, phases);
}

module.exports = {
  calcHrr,
  calcTargetHeartRate,
  calcTargetHeartRateRange,
  estimateMaxHeartRate,
  classifyCardioModality,
  buildCardioSession,
  buildFivePhaseCardio,
  FIVE_PHASE_DEFAULTS,
  CARDIO_MODALITY_CATEGORY,
};
