'use strict';
// Workout-aware meal slots.
//
// Time of day is a decision with a right answer, so the server makes it. The
// model is told the slots and their times and fills them; it does not get to
// put a "pre-workout" meal after the session or a dinner at 02:00.
//
// All arithmetic is in minutes modulo 1440: a 06:00 session implies a 04:30
// pre-workout meal and a 22:30 session implies a post-workout meal at 00:00.
// Pure: no clock, no database.

const MAIN_SLOT_DEFS = {
  breakfast: { label: 'Breakfast', anchor: 450, weight: 25, snack: false },
  snack_am: { label: 'Mid-morning snack', anchor: 660, weight: 15, snack: true },
  lunch: { label: 'Lunch', anchor: 780, weight: 30, snack: false },
  snacks: { label: 'Evening snack', anchor: 990, weight: 15, snack: true },
  dinner: { label: 'Dinner', anchor: 1200, weight: 30, snack: false },
  snack_pm: { label: 'Late snack', anchor: 1320, weight: 15, snack: true },
};

const FREQUENCY_SLOTS = {
  3: ['breakfast', 'lunch', 'dinner'],
  4: ['breakfast', 'lunch', 'snacks', 'dinner'],
  5: ['breakfast', 'snack_am', 'lunch', 'snacks', 'dinner'],
  6: ['breakfast', 'snack_am', 'lunch', 'snacks', 'dinner', 'snack_pm'],
};

const PRE_SHARE = 0.1;
const POST_SHARE = 0.15;
const SNACK_WEIGHT_TOTAL = 15;
const MAIN_WINDOW_OPEN = 300;    // 05:00 — a main meal, not a night feed
const MAIN_WINDOW_CLOSE = 1439;  // 23:59
const PRE_FLOOR = 210;           // 03:30 — earlier than this is a typo
const WORKOUT_CLEAR = 45;        // keep a main this far from a workout meal
const MAX_MOVE = 90;
const MIN_GAP = 150;

const WORD_TIMES = { morning: '07:00', afternoon: '14:00', evening: '18:00', night: '21:00' };

const mod = (n) => ((n % 1440) + 1440) % 1440;
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toClock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const clockOrNull = (minutes) => (minutes == null ? null : toClock(minutes));
const asNumber = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * 'HH:MM', 'H:MM am/pm', or a word. Returns 'HH:MM' or null.
 *
 * Anything that is not a time returns null rather than a guess: a workout at
 * an unparseable hour must not silently become 07:00 and drag every meal with
 * it.
 */
function parseWorkoutTime(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (WORD_TIMES[raw]) return WORD_TIMES[raw];

  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const suffix = m[3];
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (suffix === 'pm') hour += 12;
  }
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** The schema stores 1–12; the engine plans 3–6 and says when it adjusted. */
function clampMealFrequency(n) {
  const value = asNumber(n);
  const warning = (message) => ({ code: 'meal_frequency_clamped', message });
  if (value == null) {
    return { frequency: 4, warning: warning('No meal frequency recorded; planning four meals.') };
  }
  const rounded = Math.round(value);
  if (rounded <= 2) {
    return { frequency: 3, warning: warning(`Meal frequency raised from ${rounded} to the minimum of 3.`) };
  }
  if (rounded >= 7) {
    return { frequency: 6, warning: warning(`Meal frequency lowered from ${rounded} to the maximum of 6.`) };
  }
  return { frequency: Math.max(3, rounded), warning: null };
}

/** Snacks share one 15% slice however many of them there are. */
function mainWeights(keys) {
  const snackCount = keys.filter((k) => MAIN_SLOT_DEFS[k].snack).length;
  return keys.map((k) => (MAIN_SLOT_DEFS[k].snack
    ? SNACK_WEIGHT_TOTAL / snackCount
    : MAIN_SLOT_DEFS[k].weight));
}

const clockDistance = (a, b) => {
  const d = mod(a - b);
  return Math.min(d, 1440 - d);
};

/** Shift main meals off the workout meals, then un-cramp them. */
function placeMains(mains, preMinutes, postMinutes, warnings) {
  for (const meal of mains) {
    // Clock distance, not numeric: 23:45 and 00:15 are thirty minutes apart.
    const toPre = preMinutes == null ? Infinity : clockDistance(meal.minutes, preMinutes);
    const toPost = postMinutes == null ? Infinity : clockDistance(meal.minutes, postMinutes);
    if (Math.min(toPre, toPost) > WORKOUT_CLEAR) continue;

    const edge = toPre <= toPost ? preMinutes - WORKOUT_CLEAR : postMinutes + WORKOUT_CLEAR;
    const candidate = mod(edge);
    if (Math.abs(candidate - meal.minutes) > MAX_MOVE || candidate < MAIN_WINDOW_OPEN) {
      warnings.push({
        code: 'meal_schedule_conflict',
        message: `${meal.label} sits against the workout and cannot move clear of it.`,
      });
      continue;
    }
    meal.moved += candidate - meal.minutes;
    meal.minutes = candidate;
  }

  mains.sort((a, b) => a.minutes - b.minutes);
  for (let i = 1; i < mains.length; i += 1) {
    const current = mains[i];
    const gap = current.minutes - mains[i - 1].minutes;
    if (gap >= MIN_GAP) continue;
    const wanted = MIN_GAP - gap;
    const room = Math.max(0, Math.min(MAX_MOVE - current.moved, MAIN_WINDOW_CLOSE - current.minutes));
    const applied = Math.min(wanted, room);
    current.minutes += applied;
    current.moved += applied;
    if (applied < wanted) {
      warnings.push({
        code: 'meal_schedule_compressed',
        message: `${current.label} cannot be spaced far enough from the meal before it.`,
      });
    }
  }

  for (const meal of mains) {
    meal.minutes = Math.min(MAIN_WINDOW_CLOSE, Math.max(MAIN_WINDOW_OPEN, meal.minutes));
  }
  return mains;
}

function buildSchedule(input = {}) {
  const warnings = [];
  const { frequency, warning } = clampMealFrequency(input.meal_frequency);
  if (warning) warnings.push(warning);

  const targets = input.targets || {};
  const calorieTarget = asNumber(targets.calorie_target);
  const daily = {
    protein_g: asNumber(targets.macros?.protein_g),
    carbs_g: asNumber(targets.macros?.carbs_g),
    fat_g: asNumber(targets.macros?.fat_g),
    fiber_g: asNumber(targets.fiber_g),
  };

  // Pre-workout leading edge: a long session needs the fuel sooner.
  const duration = asNumber(input.workout_duration_minutes) ?? 60;
  const start = parseWorkoutTime(input.workout_time);
  let preMinutes = null;
  let postMinutes = null;
  if (start) {
    const startMinutes = toMinutes(start);
    const pre = mod(startMinutes - (duration >= 90 ? 60 : 90));
    if (pre < PRE_FLOOR) {
      warnings.push({
        code: 'pre_workout_suppressed',
        message: `No pre-workout meal: it would fall at ${toClock(pre)}, before 03:30.`,
      });
    } else {
      preMinutes = pre;
    }
    postMinutes = mod(startMinutes + duration + 30);
  }

  const keys = FREQUENCY_SLOTS[frequency];
  const weights = mainWeights(keys);
  const mains = keys.map((key, i) => ({
    slot: key,
    label: MAIN_SLOT_DEFS[key].label,
    minutes: mod(MAIN_SLOT_DEFS[key].anchor + (input.meal_timing_preference === 'early' ? -60
      : input.meal_timing_preference === 'late' ? 60 : 0)),
    weight: weights[i],
    moved: 0,
  }));

  placeMains(mains, preMinutes, postMinutes, warnings);

  const entries = [
    ...(preMinutes == null ? [] : [{ slot: 'pre_workout', label: 'Pre-workout', minutes: preMinutes, share: PRE_SHARE }]),
    ...mains.map((m) => ({ slot: m.slot, label: m.label, minutes: m.minutes, weight: m.weight })),
    ...(postMinutes == null ? [] : [{ slot: 'post_workout', label: 'Post-workout', minutes: postMinutes, share: POST_SHARE }]),
  ].map((e) => ({ ...e, day_offset: e.minutes < 180 ? 1 : 0 }))
    .sort((a, b) => a.day_offset - b.day_offset || a.minutes - b.minutes);

  const fixed = (preMinutes == null ? 0 : PRE_SHARE) + (postMinutes == null ? 0 : POST_SHARE);
  const weightTotal = entries.reduce((n, e) => n + (e.weight ?? 0), 0);
  for (const e of entries) {
    if (e.weight != null) e.share = (e.weight / weightTotal) * (1 - fixed);
  }

  // Shares are rounded in display order and the last one absorbs the rest, so
  // the day totals exactly 1 rather than 0.999997.
  let shareRunning = 0;
  let calorieRunning = 0;
  entries.forEach((e, i) => {
    const last = i === entries.length - 1;
    e.calorie_share = last ? 1 - shareRunning : round6(e.share);
    shareRunning += e.calorie_share;

    const scaled = calorieTarget == null ? null : Math.round(e.calorie_share * calorieTarget);
    e.calories = last && calorieTarget != null ? calorieTarget - calorieRunning : scaled;
    if (e.calories != null) calorieRunning += e.calories;
  });

  const slots = entries.map((e) => ({
    slot: e.slot,
    label: e.label,
    time: clockOrNull(e.minutes),
    day_offset: e.day_offset,
    calorie_share: e.calorie_share,
    calories: e.calories,
    protein_g: daily.protein_g == null ? null : Math.round(e.calorie_share * daily.protein_g),
    carbs_g: daily.carbs_g == null ? null : Math.round(e.calorie_share * daily.carbs_g),
    fat_g: daily.fat_g == null ? null : Math.round(e.calorie_share * daily.fat_g),
    fiber_g: daily.fiber_g == null ? null : Math.round(e.calorie_share * daily.fiber_g),
  }));

  return { slots, warnings };
}

module.exports = {
  parseWorkoutTime,
  clampMealFrequency,
  buildSchedule,
  MAIN_SLOT_DEFS,
  FREQUENCY_SLOTS,
};
