process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
const { generateWorkout, suitability } = require('../modules/pt-os/workout-generator');

const pool = [
  { id: 'squat', name: 'Back Squat', mechanic: 'compound', movementPattern: 'Squat', primaryMuscle: 'Quadriceps', equipment: 'Barbell', category: 'Strength', difficulty: 'intermediate' },
  { id: 'hinge', name: 'Romanian Deadlift', mechanic: 'compound', movementPattern: 'Hinge', primaryMuscle: 'Hamstrings', equipment: 'Barbell', category: 'Strength', difficulty: 'intermediate' },
  { id: 'bench', name: 'Bench Press', mechanic: 'compound', movementPattern: 'Horizontal Push', primaryMuscle: 'Chest', equipment: 'Barbell', category: 'Strength', difficulty: 'intermediate' },
  { id: 'row', name: 'Barbell Row', mechanic: 'compound', movementPattern: 'Horizontal Pull', primaryMuscle: 'Middle Back', equipment: 'Barbell', category: 'Strength', difficulty: 'intermediate' },
  { id: 'ohp', name: 'Overhead Press', mechanic: 'compound', movementPattern: 'Vertical Push', primaryMuscle: 'Shoulders', equipment: 'Barbell', category: 'Strength', difficulty: 'intermediate' },
  { id: 'curl', name: 'Bicep Curl', mechanic: 'isolation', movementPattern: 'Isolation', primaryMuscle: 'Biceps', equipment: 'Dumbbell', category: 'Strength', difficulty: 'beginner' },
  { id: 'bike', name: 'Stationary Bike', mechanic: 'isolation', movementPattern: 'Locomotion', primaryMuscle: 'Cardiovascular', equipment: 'Machine', category: 'Cardio', difficulty: 'beginner' },
];

test('excludes restricted movement patterns with a reason', () => {
  const r = generateWorkout({ client: { goal: 'strength', experience: 'intermediate', avoidPatterns: ['Squat'] }, pool });
  const ids = r.mainWork.map((e) => e.id);
  expect(ids).not.toContain('squat');
  expect(r.excluded.map((e) => e.id)).toContain('squat');
  expect(r.excluded[0].reason).toMatch(/Squat/);
});

test('excludes unavailable equipment', () => {
  const r = generateWorkout({ client: { goal: 'strength', equipment: ['Dumbbell'] }, pool });
  expect(r.mainWork.map((e) => e.id)).not.toContain('bench');
  expect(r.excluded.some((e) => /equipment/i.test(e.reason))).toBe(true);
});

test('deterministic: same input, same order', () => {
  const a = generateWorkout({ client: { goal: 'hypertrophy', experience: 'intermediate' }, pool });
  const b = generateWorkout({ client: { goal: 'hypertrophy', experience: 'intermediate' }, pool });
  expect(a.mainWork.map((e) => e.id)).toEqual(b.mainWork.map((e) => e.id));
});

test('holds the goal session shape', () => {
  const r = generateWorkout({ client: { goal: 'strength', experience: 'advanced', hasVerified1RM: true }, pool, options: { hasVerified1RM: true } });
  expect(r.mainWork.length).toBeGreaterThanOrEqual(4);
  expect(r.mainWork.every((e) => e.prescription && e.prescription.sets >= 1)).toBe(true);
});

test('cardio included for fat_loss, absent for strength', () => {
  const fat = generateWorkout({ client: { goal: 'fat_loss' }, pool });
  expect(fat.conditioning).not.toBeNull();
  expect(fat.conditioning.minutes).toBe(20);
  const str = generateWorkout({ client: { goal: 'strength' }, pool });
  expect(str.conditioning).toBeNull();
});

test('every generated exercise carries a reason', () => {
  const r = generateWorkout({ client: { goal: 'general_fitness' }, pool });
  expect(r.explanations.length).toBe(r.mainWork.length);
  expect(r.explanations.every((x) => x.reason.length > 10)).toBe(true);
});

test('unsuitable pool yields a warning, not a crash', () => {
  const r = generateWorkout({ client: { avoidPatterns: ['Squat', 'Hinge', 'Horizontal Push', 'Horizontal Pull', 'Vertical Push', 'Vertical Pull', 'Isolation'] }, pool });
  expect(r.mainWork.length).toBe(0);
  expect(r.warnings.length).toBeGreaterThan(0);
});

test('suitability is exposed for reuse by the AI validator', () => {
  expect(suitability({ id: 'x', name: 'X', movementPattern: 'Hinge' }, { avoidPatterns: ['Hinge'] })).toEqual({ ok: false, reason: 'movement pattern "Hinge" is restricted for this client' });
});
