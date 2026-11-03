'use strict';
// One goal vocabulary, and the 14 studio goals that have to keep working.
//
// The mismatch this closes: pt_goals accepted fourteen goal names, the plan
// column accepted seven, and the AI prompt asked for a third list. A
// powerlifting client's proposal was saved with goal NULL because the mapping
// dropped what it could not store.

const {
  CANONICAL_GOALS, LEGACY_MAP, PLAN_GOALS, classifyGoal,
} = require('../modules/pt-os/goal-classification');

describe('classifyGoal', () => {
  it('accepts every canonical goal as itself', () => {
    for (const goal of CANONICAL_GOALS) expect(classifyGoal(goal)).toBe(goal);
  });

  it('maps all fourteen studio goal values to a canonical goal or null', () => {
    // The Goal Assessment's own list (migration 055).
    const fourteen = [
      'fat_loss', 'muscle_gain', 'body_recomposition', 'strength_gain', 'powerlifting',
      'endurance', 'general_fitness', 'mobility', 'marathon_prep', 'wedding_transformation',
      'medical_fitness', 'senior_fitness', 'athletic_performance', 'custom',
    ];
    const mapped = Object.fromEntries(fourteen.map((g) => [g, classifyGoal(g)]));

    expect(mapped).toEqual({
      fat_loss: 'fat_loss',
      muscle_gain: 'hypertrophy',
      body_recomposition: 'body_recomposition',
      strength_gain: 'strength',
      powerlifting: 'powerlifting',
      endurance: 'endurance',
      general_fitness: 'general_fitness',
      mobility: 'flexibility_mobility',
      marathon_prep: 'endurance',
      wedding_transformation: 'body_recomposition',
      medical_fitness: 'general_fitness',
      senior_fitness: 'general_fitness',
      athletic_performance: 'strength',
      // A trainer's own label is not a programming goal. Guessing one would
      // program the client for something nobody chose.
      custom: null,
    });
  });

  it('reads the labels the forms and the model write', () => {
    expect(classifyGoal('Weight Loss')).toBe('fat_loss');
    expect(classifyGoal('Muscle Gain')).toBe('hypertrophy');
    expect(classifyGoal('Flexibility & Mobility')).toBe('flexibility_mobility');
    expect(classifyGoal('  body-recomposition ')).toBe('body_recomposition');
  });

  it('returns null for an unknown or empty value', () => {
    expect(classifyGoal('powerbuilding')).toBeNull();
    expect(classifyGoal('')).toBeNull();
    expect(classifyGoal(null)).toBeNull();
    expect(classifyGoal(undefined)).toBeNull();
  });
});

describe('the plan column vocabulary', () => {
  it('keeps the two legacy values existing rows carry', () => {
    // Existing plans were saved with weight_loss and muscle_gain. Rewriting
    // them would change a goal a trainer can see, so the constraint accepts
    // both and new writes classify them.
    expect(PLAN_GOALS).toEqual(expect.arrayContaining(['weight_loss', 'muscle_gain']));
    expect(PLAN_GOALS).toEqual(expect.arrayContaining(CANONICAL_GOALS));
  });

  it('does not let a legacy value escape classification', () => {
    for (const legacy of Object.keys(LEGACY_MAP)) {
      expect(CANONICAL_GOALS).toContain(classifyGoal(legacy));
    }
  });
});
