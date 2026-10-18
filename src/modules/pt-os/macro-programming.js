'use strict';

function buildMacroCycle(input) {
  const { goal, totalWeeks, includeDeload } = input || {};
  const weeks = Array.from({ length: totalWeeks || 0 }, (_, i) => i + 1);
  const phases = [];
  const tw = totalWeeks || 0;
  if (tw <= 4) {
    phases.push({ name: 'Accumulation', weeks: [...weeks], focus: 'Volume and technique' });
    return { phases, weeks };
  }
  const accumEnd = Math.max(1, Math.round(tw * 0.6));
  const intensEnd = Math.max(accumEnd + 1, Math.round(tw * 0.85));
  phases.push({ name: 'Accumulation', weeks: weeks.slice(0, accumEnd), focus: 'Volume accumulation' });
  phases.push({ name: 'Intensification', weeks: weeks.slice(accumEnd, intensEnd), focus: 'Intensity increase' });
  phases.push({ name: 'Deload / Peak', weeks: weeks.slice(intensEnd), focus: includeDeload ? 'Deload then peak' : 'Peak' });
  if (goal === 'strength' || goal === 'powerlifting') phases[1].focus = 'Heavy singles/doubles';
  return { phases, weeks };
}

function microCycleDays(daysPerWeek) {
  const labels = ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'];
  const n = Math.max(1, Math.min(7, daysPerWeek || 1));
  return labels.slice(0, n);
}

function deloadWeek(loadMultiplier) {
  return loadMultiplier != null ? loadMultiplier : 0.6;
}

module.exports = { buildMacroCycle, microCycleDays, deloadWeek };
