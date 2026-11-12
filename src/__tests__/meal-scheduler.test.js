'use strict';

const { parseWorkoutTime, clampMealFrequency, buildSchedule } = require('../modules/nutrition/meal-scheduler');

const TARGETS = {
  calorie_target: 2000,
  macros: { protein_g: 150, carbs_g: 200, fat_g: 60 },
  fiber_g: 30,
};
const BASE = {
  workout_time: null,
  meal_frequency: 4,
  meal_timing_preference: 'standard',
  targets: TARGETS,
};

test('workout time forms', () => {
  expect(parseWorkoutTime('07:00')).toBe('07:00');
  expect(parseWorkoutTime('7:05 am')).toBe('07:05');
  expect(parseWorkoutTime('7:05 pm')).toBe('19:05');
  expect(parseWorkoutTime('morning')).toBe('07:00');
  expect(parseWorkoutTime('evening')).toBe('18:00');
  expect(parseWorkoutTime('25:00')).toBeNull();
});

test('frequency clamps and warns', () => {
  expect(clampMealFrequency(1)).toEqual({ frequency: 3, warning: expect.objectContaining({ code: 'meal_frequency_clamped' }) });
  expect(clampMealFrequency(8)).toEqual({ frequency: 6, warning: expect.objectContaining({ code: 'meal_frequency_clamped' }) });
  expect(clampMealFrequency(4)).toEqual({ frequency: 4, warning: null });
});

test('no workout time: mains only, shares sum to 1', () => {
  const { slots } = buildSchedule({
    workout_time: null,
    meal_frequency: 4,
    meal_timing_preference: 'standard',
    targets: TARGETS,
  });
  expect(slots.map((s) => s.slot)).toEqual(['breakfast', 'lunch', 'snacks', 'dinner']);
  expect(slots.every((s) => s.day_offset === 0)).toBe(true);
  expect(slots.reduce((n, s) => n + s.calorie_share, 0)).toBeCloseTo(1, 10);
});

test('07:00 workout adds a pre at 05:30 and a post at 08:30', () => {
  const { slots } = buildSchedule({
    workout_time: '07:00',
    workout_duration_minutes: 60,
    meal_frequency: 4,
    meal_timing_preference: 'standard',
    targets: TARGETS,
  });
  expect(slots.find((s) => s.slot === 'pre_workout').time).toBe('05:30');
  expect(slots.find((s) => s.slot === 'post_workout').time).toBe('08:30');
  expect(slots.reduce((n, s) => n + s.calorie_share, 0)).toBeCloseTo(1, 10);
});

test('22:30 workout: post after midnight carries day_offset 1', () => {
  const { slots } = buildSchedule({
    workout_time: '22:30',
    workout_duration_minutes: 60,
    meal_frequency: 4,
    meal_timing_preference: 'standard',
    targets: TARGETS,
  });
  const post = slots.find((s) => s.slot === 'post_workout');
  expect(post.time).toBe('00:00');
  expect(post.day_offset).toBe(1);
});

test('02:00 pre slot is suppressed, not blocked', () => {
  const { slots, warnings } = buildSchedule({
    workout_time: '03:30',
    workout_duration_minutes: 60,
    meal_frequency: 4,
    meal_timing_preference: 'standard',
    targets: TARGETS,
  });
  expect(slots.some((s) => s.slot === 'pre_workout')).toBe(false);
  expect(warnings.map((w) => w.code)).toContain('pre_workout_suppressed');
});

test('early and late preferences shift main anchors by an hour', () => {
  const early = buildSchedule({ ...BASE, meal_timing_preference: 'early' }).slots;
  const late = buildSchedule({ ...BASE, meal_timing_preference: 'late' }).slots;
  expect(early.find((s) => s.slot === 'breakfast').time).toBe('06:30');
  expect(late.find((s) => s.slot === 'breakfast').time).toBe('08:30');
});

test('a noon workout pushes lunch clear and un-cramps the snack after it', () => {
  const { slots } = buildSchedule({
    workout_time: '12:00',
    workout_duration_minutes: 60,
    meal_frequency: 4,
    meal_timing_preference: 'standard',
    targets: TARGETS,
  });
  expect(slots.find((s) => s.slot === 'lunch').time).toBe('14:15');
  expect(slots.find((s) => s.slot === 'snacks').time).toBe('16:45');
});

test('slot calories total the daily target exactly', () => {
  const { slots } = buildSchedule({
    workout_time: '07:00',
    workout_duration_minutes: 60,
    meal_frequency: 5,
    meal_timing_preference: 'standard',
    targets: TARGETS,
  });
  expect(slots.reduce((n, s) => n + s.calories, 0)).toBe(2000);
  expect(slots.every((s) => /^\d{2}:\d{2}$/.test(s.time))).toBe(true);
});
