'use strict';
// One goal vocabulary for programming.
//
// Three vocabularies existed and disagreed:
//
//   pt_goals.goal_type      14 values, including powerlifting and mobility
//   workout_plans.goal       7 values, no powerlifting and no mobility
//   the AI prompt            7 values, no hypertrophy (it said muscle_gain)
//
// A client whose active goal was `powerlifting` therefore produced a proposal
// the save path could not store: plan-materialise dropped the goal to NULL
// rather than fail on the CHECK. The programme was real and the goal that
// shaped it was gone.
//
// The canonical nine are the programming goals the engines can act on. The
// legacy names are not aliases for display — they are what the studio's own
// Goal Assessment writes today, so they must keep classifying to the same
// thing rather than becoming a second vocabulary.

const CANONICAL_GOALS = Object.freeze([
  'hypertrophy',
  'strength',
  'fat_loss',
  'endurance',
  'general_fitness',
  'body_recomposition',
  'recovery',
  'flexibility_mobility',
  'powerlifting',
]);

/**
 * Names the product already stores, and what they mean for programming.
 *
 * `custom` is deliberately absent: it is the trainer's own label, not a
 * prescription, and guessing a canonical goal from it would program the
 * client for something nobody chose. It classifies to null.
 */
const LEGACY_MAP = Object.freeze({
  weight_loss: 'fat_loss',
  muscle_gain: 'hypertrophy',
  strength_gain: 'strength',
  mobility: 'flexibility_mobility',
  flexibility: 'flexibility_mobility',
  marathon_prep: 'endurance',
  athletic_performance: 'strength',
  wedding_transformation: 'body_recomposition',
  medical_fitness: 'general_fitness',
  senior_fitness: 'general_fitness',
});

const FOLD = (v) => String(v ?? '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

/**
 * Canonical goal, or null when the value names no programming goal.
 *
 * Labels are accepted ("Weight Loss", "Flexibility & Mobility") because the
 * generator and the assessment forms both write them.
 */
function classifyGoal(raw) {
  const key = FOLD(raw);
  if (!key) return null;
  if (CANONICAL_GOALS.includes(key)) return key;
  return LEGACY_MAP[key] ?? null;
}

/** Values workout_plans.goal accepts: canonical plus the two stored legacy names. */
const PLAN_GOALS = Object.freeze([...CANONICAL_GOALS, 'weight_loss', 'muscle_gain']);

module.exports = { CANONICAL_GOALS, LEGACY_MAP, PLAN_GOALS, classifyGoal };
