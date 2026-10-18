'use strict';

const RM_RANGES = {
  beginner: { min: 15, max: 20 },
  intermediate: { min: 10, max: 15 },
  advanced: { min: 6, max: 8 },
};

function rmRangeForExperience(level) {
  return RM_RANGES[level] || RM_RANGES.beginner;
}

function experienceFromTrainingAge(years) {
  if (years == null || !Number.isFinite(years) || years < 0) return 'beginner';
  if (years < 1) return 'beginner';
  if (years < 3) return 'intermediate';
  return 'advanced';
}

function prescribeStrengthLoad(params) {
  const { experience, goal, mechanic, hasVerified1RM } = params || {};
  const lvl = experience || 'beginner';
  const base = rmRangeForExperience(lvl);
  let reps = `${base.min}-${base.max}`;
  let sets = mechanic === 'compound' ? 4 : 3;
  let restSeconds = mechanic === 'compound' ? 120 : 60;
  let rpe = 7;
  let rir = 2;
  let intensityPct1RM = null;
  const notes = [];

  if (goal === 'strength' || goal === 'powerlifting') {
    reps = lvl === 'advanced' ? '3-5' : '5-8';
    sets = mechanic === 'compound' ? 5 : 3;
    restSeconds = 180;
    rpe = 8;
    rir = 1;
    if (hasVerified1RM) intensityPct1RM = 85;
    notes.push('Strength focus: longer rest, lower reps.');
  } else if (goal === 'hypertrophy') {
    reps = '8-12';
    sets = 3;
    restSeconds = 90;
    rpe = 8;
    rir = 1;
    if (hasVerified1RM) intensityPct1RM = 70;
  } else if (goal === 'endurance') {
    reps = '15-20';
    sets = 2;
    restSeconds = 45;
    rpe = 6;
    rir = 3;
  } else if (goal === 'fat_loss') {
    reps = '10-15';
    sets = 3;
    restSeconds = 60;
    rpe = 7;
    rir = 2;
  }

  if (lvl === 'beginner') {
    rpe = Math.min(rpe, 6);
    if (intensityPct1RM != null) intensityPct1RM = Math.min(intensityPct1RM, 60);
    notes.push('Beginner: conservative load, prioritize technique.');
  }
  if (!hasVerified1RM) {
    intensityPct1RM = null;
    notes.push('No verified 1RM: use RPE/RIR autoregulation, conservative estimates.');
  }

  return { sets, reps, rpe, rir, restSeconds, intensityPct1RM, notes: notes.join(' ') };
}

function warmupSetsFor() {
  return [
    { sets: 1, reps: '5', loadPct: 50 },
    { sets: 1, reps: '3', loadPct: 70 },
  ];
}

module.exports = {
  rmRangeForExperience,
  experienceFromTrainingAge,
  prescribeStrengthLoad,
  warmupSetsFor,
  RM_RANGES,
};
