// Training volume, and the session summary built on it.
//
// ── Two units that are both called "volume" ────────────────────────────────
//
// Trainers use the word for two different measurements, and conflating them
// makes a chart that nobody can act on:
//
//   LOAD volume    kg lifted — sum of weight × reps. Answers "did they do
//                  more work", and is meaningless for bodyweight or cardio.
//   HARD SETS      a count of working sets per muscle. Answers "is this
//                  muscle getting enough stimulus", and is what MEV/MRV
//                  landmarks (muscle_volume_landmarks) are expressed in.
//
// Both are returned, separately, named for what they are.
//
// ── What does not count ────────────────────────────────────────────────────
//
// Warm-up sets are excluded from hard sets. A landmark of "10-20 sets per week
// for chest" means working sets; counting warm-ups inflates every client into
// the overreaching band and makes the landmark useless. They still count
// toward load volume, because the weight was genuinely moved.
//
// Pure functions. No database.
'use strict';

const u = require('./units');

const num = (v) => (v == null || v === '' ? null : Number(v));

/** Sets that count as work: completed, with reps, and not a warm-up. */
function isWorkingSet(set) {
  return Boolean(set)
    && set.completed === true
    && set.set_type !== 'WARMUP'
    && Number(set.actual_reps) > 0;
}

/** kg × reps for one set, in kilograms whatever it was entered in. */
function setLoadKg(set) {
  if (!set || !set.completed) return 0;
  const kg = u.toKg(set.actual_weight, set.weight_unit || 'kg');
  const reps = num(set.actual_reps);
  if (kg == null || reps == null || kg <= 0 || reps <= 0) return 0;
  return kg * reps;
}

/**
 * Load volume and hard sets for one exercise's sets.
 *
 * Bodyweight work returns load 0 and a real hard-set count, which is correct
 * rather than a gap: press-ups produce stimulus and no external load, and
 * reporting them as "0 volume" alongside a hard-set count says exactly that.
 */
function summariseSets(sets) {
  const list = sets || [];
  let loadKg = 0;
  let hardSets = 0;
  let reps = 0;
  for (const s of list) {
    loadKg += setLoadKg(s);
    if (isWorkingSet(s)) { hardSets += 1; reps += num(s.actual_reps) ?? 0; }
  }
  return { loadKg, hardSets, reps };
}

/**
 * Cardio totals.
 *
 * Distance accumulates in metres — the only way to add a 5 km run to a
 * 3 mile walk without one of them being silently converted on write.
 */
function summariseCardio(cardios) {
  const list = (cardios || []).filter((c) => c && c.completed);
  let distanceMetres = 0;
  let durationSeconds = 0;
  let calories = 0;
  for (const c of list) {
    distanceMetres += u.toMetres(c.distance, c.distance_unit) ?? 0;
    durationSeconds += num(c.duration_seconds) ?? 0;
    calories += num(c.calories_burned) ?? 0;
  }
  return { efforts: list.length, distanceMetres, durationSeconds, calories };
}

/**
 * Hard sets per muscle.
 *
 * @param {object[]} performances  each {exercise_id, sets}
 * @param {Map|object} muscleByExercise  exercise_id → [{muscle, role}]
 *
 * A secondary muscle counts as HALF a set, which is the convention the
 * MEV/MRV literature these landmarks come from uses. Counting it as a whole
 * set makes every compound lift look like direct work for four muscles;
 * counting it as zero makes a programme of nothing but compounds look like it
 * trains nothing. Half is the compromise the field settled on, and it is
 * stated here rather than buried so a studio that disagrees can find it.
 */
const SECONDARY_WEIGHT = 0.5;

function hardSetsByMuscle(performances, muscleByExercise) {
  const lookup = muscleByExercise instanceof Map
    ? muscleByExercise
    : new Map(Object.entries(muscleByExercise || {}));
  const out = new Map();

  for (const perf of performances || []) {
    const { hardSets } = summariseSets(perf?.sets);
    if (!hardSets) continue;
    const muscles = lookup.get(perf.exercise_id) || [];
    for (const m of muscles) {
      const name = typeof m === 'string' ? m : m.muscle;
      const role = typeof m === 'string' ? 'PRIMARY' : (m.role || 'PRIMARY');
      if (!name) continue;
      const weight = role === 'SECONDARY' ? SECONDARY_WEIGHT : 1;
      out.set(name, (out.get(name) ?? 0) + hardSets * weight);
    }
  }
  return out;
}

/**
 * The screen a client sees when they finish.
 *
 * Averages RPE across whatever reported one — sets and cardio efforts alike,
 * since a client rates a treadmill run on the same scale they rate a squat.
 * Returns null rather than 0 when nothing was rated: "average RPE 0" reads as
 * an effortless session rather than an unrecorded one.
 */
function sessionSummary(performances, opts = {}) {
  let loadKg = 0;
  let hardSets = 0;
  let reps = 0;
  const rpes = [];
  const cardios = [];
  let exercisesCompleted = 0;

  for (const perf of performances || []) {
    const s = summariseSets(perf?.sets);
    loadKg += s.loadKg;
    hardSets += s.hardSets;
    reps += s.reps;

    for (const set of perf?.sets || []) {
      const r = num(set?.actual_rpe);
      if (set?.completed && r != null) rpes.push(r);
    }
    for (const c of perf?.cardio || []) {
      cardios.push(c);
      const r = num(c?.rpe);
      if (c?.completed && r != null) rpes.push(r);
    }
    const didSets = (perf?.sets || []).some((x) => x?.completed);
    const didCardio = (perf?.cardio || []).some((x) => x?.completed);
    if (didSets || didCardio) exercisesCompleted += 1;
  }

  const cardio = summariseCardio(cardios);
  const averageRpe = rpes.length
    ? Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10
    : null;

  return {
    exercises: (performances || []).length,
    exercisesCompleted,
    strength: {
      loadKg: Math.round(loadKg * 100) / 100,
      hardSets,
      reps,
    },
    cardio: {
      efforts: cardio.efforts,
      distanceMetres: Math.round(cardio.distanceMetres * 1000) / 1000,
      distanceKm: Math.round((cardio.distanceMetres / 1000) * 1000) / 1000,
      durationSeconds: cardio.durationSeconds,
      calories: cardio.calories,
    },
    averageRpe,
    durationSeconds: num(opts.durationSeconds) ?? null,
  };
}

module.exports = {
  SECONDARY_WEIGHT,
  isWorkingSet, setLoadKg,
  summariseSets, summariseCardio, hardSetsByMuscle, sessionSummary,
};
