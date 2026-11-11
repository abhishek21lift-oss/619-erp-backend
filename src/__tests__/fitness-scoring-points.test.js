'use strict';

const {
  scoreBpPoints, scoreAnthropometricPoints, scoreBodyCompositionPoints, scoreCardioPoints,
} = require('../modules/progress/fitness-scoring');

test('BP points follow the framework', () => {
  expect(scoreBpPoints('Normal')).toEqual({ points: 10, max: 10 });
  expect(scoreBpPoints('Elevated')).toEqual({ points: 7, max: 10 });
  expect(scoreBpPoints('Hypertension Stage 1')).toEqual({ points: 4, max: 10 });
  expect(scoreBpPoints('Hypertension Stage 2')).toEqual({ points: 0, max: 10 });
  expect(scoreBpPoints('Hypertensive Crisis')).toEqual({ points: 0, max: 10 });
  expect(scoreBpPoints('Hypotension')).toEqual({ points: 7, max: 10 });
  expect(scoreBpPoints(null)).toEqual({ points: null, max: 0 });
});

test('anthropometry counts parameters out of range', () => {
  const all = { bmi: 22, waistIliacCm: 85, waistCm: 80, waistHipRatio: 0.9 };
  expect(scoreAnthropometricPoints(all, 'Male')).toEqual({ points: 10, max: 10 });
  expect(scoreAnthropometricPoints({ ...all, bmi: 27.1 }, 'Male')).toEqual({ points: 7, max: 10 });
  expect(scoreAnthropometricPoints({ ...all, bmi: 27.1, waistHipRatio: 1.07 }, 'Male')).toEqual({ points: 4, max: 10 });
  expect(scoreAnthropometricPoints({ bmi: 27.1, waistIliacCm: 98, waistHipRatio: 1.07 }, 'Male')).toEqual({ points: 2, max: 10 });
  expect(scoreAnthropometricPoints({ bmi: 22, waistIliacCm: 85 }, 'Male')).toEqual({ points: 6.7, max: 6.7 });
  expect(scoreAnthropometricPoints({ bmi: 22 }, null)).toEqual({ points: 3.3, max: 3.3 });
  expect(scoreAnthropometricPoints({}, 'Male')).toEqual({ points: null, max: 0 });
});

test('body composition uses the stored category bands', () => {
  // Exactly 15% male / 20% female classify as Acceptable / Average, so the
  // points match the label the tile shows beside them.
  expect(scoreBodyCompositionPoints(15, 'Male')).toEqual({ points: 11, max: 15 });
  expect(scoreBodyCompositionPoints(14, 'Male')).toEqual({ points: 15, max: 15 });
  expect(scoreBodyCompositionPoints(16, 'Male')).toEqual({ points: 11, max: 15 });
  expect(scoreBodyCompositionPoints(21, 'Male')).toEqual({ points: 7, max: 15 });
  expect(scoreBodyCompositionPoints(30, 'Male')).toEqual({ points: 3, max: 15 });
  expect(scoreBodyCompositionPoints(20, 'Female')).toEqual({ points: 11, max: 15 });
  expect(scoreBodyCompositionPoints(19, 'Female')).toEqual({ points: 15, max: 15 });
  expect(scoreBodyCompositionPoints(21, 'Female')).toEqual({ points: 11, max: 15 });
  expect(scoreBodyCompositionPoints(null, 'Male')).toEqual({ points: null, max: 0 });
});

test('cardio maps every K11 category into the six framework buckets', () => {
  for (const c of ['Superior', 'Excellent']) expect(scoreCardioPoints(c)).toEqual({ points: 20, max: 20 });
  for (const c of ['Very Good', 'Good']) expect(scoreCardioPoints(c)).toEqual({ points: 16, max: 20 });
  expect(scoreCardioPoints('Above Average')).toEqual({ points: 13, max: 20 });
  for (const c of ['Average', 'Fair']) expect(scoreCardioPoints(c)).toEqual({ points: 10, max: 20 });
  expect(scoreCardioPoints('Below Average')).toEqual({ points: 6, max: 20 });
  for (const c of ['Poor', 'Very Poor', 'Below Supported Range']) expect(scoreCardioPoints(c)).toEqual({ points: 2, max: 20 });
  expect(scoreCardioPoints(null)).toEqual({ points: null, max: 0 });
});
