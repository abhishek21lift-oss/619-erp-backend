process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
const rm = require('../modules/pt-os/rm-prescription');

test('beginner range', () => {
  expect(rm.rmRangeForExperience('beginner')).toEqual({ min: 15, max: 20 });
});

test('prescribe conservative for beginner', () => {
  const p = rm.prescribeStrengthLoad({ experience: 'beginner', goal: 'hypertrophy', mechanic: 'compound', hasVerified1RM: false });
  expect(p.rpe).toBeLessThanOrEqual(6);
  expect(p.intensityPct1RM).toBeNull();
});

test('strength advanced verified 1rm', () => {
  const p = rm.prescribeStrengthLoad({ experience: 'advanced', goal: 'strength', mechanic: 'compound', hasVerified1RM: true });
  expect(p.intensityPct1RM).toBe(85);
});

test('experience from training age', () => {
  expect(rm.experienceFromTrainingAge(0.5)).toBe('beginner');
  expect(rm.experienceFromTrainingAge(5)).toBe('advanced');
});
