'use strict';

const { scoreFlexibilityPoints } = require('../modules/progress/fitness-scoring');
const flexibilityProtocol = require('../modules/progress/flexibility-protocol');

const CONTEXT = { age: 30, gender: 'Male' };

function recorded(overrides = {}) {
  return {
    protocol_version: 'k11-2026.02',
    tests: {
      quadriceps: {
        completed: true,
        sides: {
          left: { contact: true, pain: false, pelvic_compensation: false },
          right: { contact: true, pain: false, pelvic_compensation: false },
        },
      },
      hamstrings: {
        completed: true,
        sides: {
          left: { hip_flexion_deg: 75, knee_extended: true, pelvic_compensation: false },
          right: { hip_flexion_deg: 75, knee_extended: true, pelvic_compensation: false },
        },
      },
      hip_flexors: {
        completed: true,
        sides: {
          left: { thigh_position: 'below', pelvic_compensation: false },
          right: { thigh_position: 'below', pelvic_compensation: false },
        },
      },
      sit_and_reach: { completed: true, attempts: [{ inches: 22, valid: true }] },
      shoulder_reach: {
        completed: true,
        sides: { left: { reach: 'overlap' }, right: { reach: 'overlap' } },
      },
      ...overrides,
    },
  };
}

const derive = (raw, context = CONTEXT) => flexibilityProtocol.deriveFlexibility(raw, context);

test('all five tests normal scores the full 15', () => {
  expect(scoreFlexibilityPoints(derive(recorded()), null)).toEqual({ points: 15, max: 15 });
});

test('a restricted hip flexor side costs its 2 points but keeps the max', () => {
  const raw = recorded();
  raw.tests.hip_flexors.sides.left.thigh_position = 'at';
  expect(scoreFlexibilityPoints(derive(raw), null)).toEqual({ points: 13, max: 15 });
});

test('an unable-to-complete hamstrings test scores 0 of 2, not an absent max', () => {
  const raw = recorded();
  raw.tests.hamstrings = { unable_to_complete: true, unable_reason: 'Pain' };
  expect(scoreFlexibilityPoints(derive(raw), null)).toEqual({ points: 13, max: 15 });
});

test('a four-test legacy payload tops out at 13', () => {
  const raw = recorded();
  raw.protocol_version = 'k11-2026.01';
  delete raw.tests.shoulder_reach;
  expect(scoreFlexibilityPoints(derive(raw), null)).toEqual({ points: 13, max: 13 });
});

test('a performed sit-and-reach without an age/sex norm adds no max', () => {
  const raw = recorded();
  expect(scoreFlexibilityPoints(derive(raw, {}), null)).toEqual({ points: 8, max: 8 });
});

test('legacy two-slot composite converts from its 0-100 scale', () => {
  expect(scoreFlexibilityPoints(null, 80)).toEqual({ points: 12, max: 15 });
  expect(scoreFlexibilityPoints(null, 87)).toEqual({ points: 13, max: 15 });
});

test('nothing recorded is unscored, not zero', () => {
  expect(scoreFlexibilityPoints(null, null)).toEqual({ points: null, max: 0 });
});
