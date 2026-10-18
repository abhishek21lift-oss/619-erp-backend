process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
const cardio = require('../modules/pt-os/cardio');

test('karvonen target hr', () => {
  // MHR 180, RHR 60, 0.7 => (120*0.7)+60 = 144
  expect(cardio.calcTargetHeartRate(180, 60, 0.7)).toBe(144);
});

test('invalid inputs return null', () => {
  expect(cardio.calcTargetHeartRate(60, 180, 0.7)).toBeNull();
  expect(cardio.calcTargetHeartRate(180, 60, 1.5)).toBeNull();
});

test('five phase total', () => {
  const r = cardio.buildFivePhaseCardio(180, 60);
  expect(r.totalMinutes).toBe(5 + 3 + 20 + 5 + 5);
});

test('estimate mhr', () => {
  expect(cardio.estimateMaxHeartRate(30)).toBe(190);
});

test('classify modality', () => {
  expect(cardio.classifyCardioModality('Running')).toBe('weight-bearing-high-impact');
  expect(cardio.classifyCardioModality('Cycling')).toBe('non-weight-bearing');
});
