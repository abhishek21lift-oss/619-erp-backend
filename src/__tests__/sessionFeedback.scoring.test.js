'use strict';

const {
  DEFAULT_WEIGHTS, OPTIONS, scoreFeedback, weightsFromEnv,
} = require('../lib/sessionFeedback');

const BEST = {
  trainer_behaviour: 'excellent',
  form_technique: 'always',
  workout_intensity: 'perfect',
  motivation_guidance: 'absolutely',
  overall_stars: 5,
};

const WORST = {
  trainer_behaviour: 'poor',
  form_technique: 'no',
  workout_intensity: 'too_hard',
  motivation_guidance: 'not_really',
  overall_stars: 1,
};

describe('session feedback scoring', () => {
  it('gives a perfect session 5.00', () => {
    expect(scoreFeedback(BEST)).toBe(5);
  });

  it('gives the worst possible answers 0.50, because intensity is neutral at its floor', () => {
    // Behaviour/technique/motivation/overall reach zero; intensity's two
    // non-perfect options are both "not quite right", not "bad".
    expect(scoreFeedback(WORST)).toBe(0.5);
  });

  it('applies the published weights to one mixed answer set', () => {
    // 5*0.20 + 3.33*0.25 + 2.5*0.20 + 2.5*0.15 + 3.75*0.20 = 3.4575
    expect(scoreFeedback({
      trainer_behaviour: 'excellent',
      form_technique: 'mostly',
      workout_intensity: 'too_easy',
      motivation_guidance: 'somewhat',
      overall_stars: 4,
    })).toBe(3.46);
  });

  it('normalises one-to-five stars onto the same zero-to-five scale', () => {
    const stars = (overall_stars) => scoreFeedback({ ...BEST, overall_stars });
    expect(stars(1)).toBe(4);
    expect(stars(3)).toBe(4.5);
    expect(stars(5)).toBe(5);
  });

  it('rejects an answer the UI does not offer', () => {
    expect(() => scoreFeedback({ ...BEST, trainer_behaviour: 'great' })).toThrow(/trainer_behaviour/);
    expect(() => scoreFeedback({ ...BEST, overall_stars: 6 })).toThrow(/overall_stars/);
  });

  it('ships the published default weights', () => {
    expect(DEFAULT_WEIGHTS).toEqual({
      behaviour: 0.20, technique: 0.25, intensity: 0.20, motivation: 0.15, overall: 0.20,
    });
  });

  it('accepts a valid JSON override', () => {
    const weights = weightsFromEnv({
      FEEDBACK_WEIGHTS: JSON.stringify({
        behaviour: 0.1, technique: 0.1, intensity: 0.1, motivation: 0.1, overall: 0.6,
      }),
    });
    expect(weights.overall).toBe(0.6);
    // Best on the four 10% questions = 2.00; 2 stars = 1.25 × 0.60 = 0.75.
    expect(scoreFeedback({ ...BEST, overall_stars: 2 }, weights)).toBe(2.75);
  });

  it('falls back to the defaults when the override is malformed or does not sum to one', () => {
    expect(weightsFromEnv({ FEEDBACK_WEIGHTS: '{not json' })).toEqual(DEFAULT_WEIGHTS);
    expect(weightsFromEnv({
      FEEDBACK_WEIGHTS: JSON.stringify({ behaviour: 1, technique: 1, intensity: 1, motivation: 1, overall: 1 }),
    })).toEqual(DEFAULT_WEIGHTS);
    expect(weightsFromEnv({ FEEDBACK_WEIGHTS: JSON.stringify({ behaviour: 1 }) })).toEqual(DEFAULT_WEIGHTS);
  });

  it('exposes exactly the option sets the migration accepts', () => {
    expect(OPTIONS.trainer_behaviour).toEqual(['excellent', 'good', 'average', 'poor']);
    expect(OPTIONS.form_technique).toEqual(['always', 'mostly', 'sometimes', 'no']);
    expect(OPTIONS.workout_intensity).toEqual(['perfect', 'too_easy', 'too_hard']);
    expect(OPTIONS.motivation_guidance).toEqual(['absolutely', 'somewhat', 'not_really']);
  });
});
