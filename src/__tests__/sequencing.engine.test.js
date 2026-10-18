process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
const seq = require('../modules/pt-os/exercise-sequencing');

test('compound before isolation', () => {
  const out = seq.sequenceWorkout([
    { id: '1', name: 'Bicep Curl', mechanic: 'isolation' },
    { id: '2', name: 'Squat', mechanic: 'compound', movementPattern: 'Squat' },
  ]);
  expect(out[0].name).toBe('Squat');
});

test('locked preserved', () => {
  const out = seq.sequenceWorkout([
    { id: '1', name: 'Curl', mechanic: 'isolation', locked: true },
    { id: '2', name: 'Squat', mechanic: 'compound', movementPattern: 'Squat' },
  ]);
  expect(out[0].locked).toBe(true);
});
