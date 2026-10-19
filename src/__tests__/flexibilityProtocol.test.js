'use strict';
// K11 four-test flexibility battery: derivation, validation and the stored
// payload. Module under test: src/modules/progress/flexibility-protocol.js.

const protocol = require('../modules/progress/flexibility-protocol');

const quadSide = (over = {}) => ({
  contact: true, distance_cm: null, pain: false, pelvic_compensation: false, tightness: 'Mild', notes: '', ...over,
});
const hamSide = (over = {}) => ({
  hip_flexion_deg: 75, knee_extended: true, pelvic_compensation: false, pain: false, tightness: 'Normal', notes: '', ...over,
});
const hipSide = (over = {}) => ({
  thigh_position: 'below', knee_flexion_deg: 30, pelvic_compensation: false, pain: false, tightness: 'Normal', notes: '', ...over,
});

function battery() {
  return {
    protocol_version: protocol.PROTOCOL_VERSION,
    tests: {
      quadriceps: { sides: { left: quadSide(), right: quadSide() }, completed: true },
      hamstrings: { sides: { left: hamSide(), right: hamSide() }, completed: true },
      hip_flexors: { sides: { left: hipSide(), right: hipSide() }, completed: true },
      sit_and_reach: {
        attempts: [{ inches: 16, valid: true }], knee_bending: false, bouncing: false, notes: '', completed: true,
      },
    },
  };
}

/** Battery with one test replaced. */
function withTest(key, value) {
  const b = battery();
  b.tests[key] = value;
  return b;
}

function parsed(input) {
  const result = protocol.parseRecorded(input);
  expect(result.ok).toBe(true);
  return result.recorded;
}

const derive = (input) => protocol.deriveFlexibility(parsed(input));

describe('K11 flexibility derivation', () => {
  test('a fully recorded, clear battery is all_tests_recorded with no follow-up', () => {
    const d = derive(battery());
    expect(d.overall_status).toBe('all_tests_recorded');
    expect(d.override_used).toBe(false);
    expect(d.has_asymmetry).toBe(false);
    expect(d.tests.quadriceps.overall_interpretation).toBe('Normal');
    expect(d.tests.hip_flexors.sides_interpretation).toEqual({ left: 'Clear', right: 'Clear' });
  });

  test('quadriceps: Normal needs contact with no pain and no pelvic compensation', () => {
    const normal = derive(battery()).tests.quadriceps;
    expect(normal.sides_interpretation.left).toBe('Normal');

    const pain = derive(withTest('quadriceps', {
      sides: { left: quadSide({ contact: true, pain: true }), right: quadSide({ contact: true }) }, completed: true,
    })).tests.quadriceps;
    expect(pain.sides_interpretation.left).toBe('Possible tightness');
    expect(pain.overall_interpretation).toBe('Possible tightness');

    const noContact = derive(withTest('quadriceps', {
      sides: { left: quadSide({ contact: false }), right: quadSide({ contact: true }) }, completed: true,
    })).tests.quadriceps;
    expect(noContact.sides_interpretation.left).toBe('Possible tightness');
    expect(noContact.sides_interpretation.right).toBe('Normal');

    const pelvic = derive(withTest('quadriceps', {
      sides: { left: quadSide({ contact: true, pelvic_compensation: true }), right: quadSide({ contact: true }) }, completed: true,
    })).tests.quadriceps;
    expect(pelvic.sides_interpretation.left).toBe('Possible tightness');
  });

  test('hamstrings: 70-80° is within the supplied protocol reference range', () => {
    const band = (deg) => derive(withTest('hamstrings', {
      sides: { left: hamSide({ hip_flexion_deg: deg }), right: hamSide({ hip_flexion_deg: deg }) }, completed: true,
    })).tests.hamstrings.sides_interpretation.left;
    expect(band(69)).toBe('Below reference range');
    expect(band(70)).toBe('Within reference range');
    expect(band(80)).toBe('Within reference range');
    expect(band(81)).toBe('Above reference range');
  });

  test('hamstrings: a bent knee or compensated pelvis is invalid_repeat and needs a repeat', () => {
    const bent = derive(withTest('hamstrings', {
      sides: { left: hamSide({ knee_extended: false }), right: hamSide() }, completed: true,
    }));
    expect(bent.tests.hamstrings.sides_validity.left).toBe('invalid_repeat');
    expect(bent.tests.hamstrings.sides_validity.right).toBe('valid');
    expect(bent.overall_status).toBe('follow_up_recommended');

    const compensated = derive(withTest('hamstrings', {
      sides: { left: hamSide({ pelvic_compensation: true }), right: hamSide() }, completed: true,
    }));
    expect(compensated.tests.hamstrings.sides_validity.left).toBe('invalid_repeat');
  });

  test('Thomas test: below the table line is Clear, at or above can be a restriction', () => {
    const at = derive(withTest('hip_flexors', {
      sides: { left: hipSide({ thigh_position: 'at' }), right: hipSide() }, completed: true,
    }));
    expect(at.tests.hip_flexors.sides_interpretation).toEqual({ left: 'Possible hip flexor restriction', right: 'Clear' });
    expect(at.overall_status).toBe('follow_up_recommended');

    const above = derive(withTest('hip_flexors', {
      sides: { left: hipSide({ thigh_position: 'above' }), right: hipSide() }, completed: true,
    }));
    expect(above.tests.hip_flexors.sides_interpretation.left).toBe('Possible hip flexor restriction');

    const belowButCompensated = derive(withTest('hip_flexors', {
      sides: { left: hipSide({ pelvic_compensation: true }), right: hipSide() }, completed: true,
    }));
    expect(belowButCompensated.tests.hip_flexors.sides_interpretation.left).toBe('Possible hip flexor restriction');
  });

  test('sit and reach: the score is best valid reach minus the 15-inch zero point, negatives allowed', () => {
    const d = derive(withTest('sit_and_reach', {
      attempts: [{ inches: 12, valid: true }, { inches: 20, valid: false }, { inches: 18.5, valid: true }],
      knee_bending: false, bouncing: false, notes: '', completed: true,
    })).tests.sit_and_reach;
    expect(d.best_attempt_index).toBe(2); // the invalid attempt never wins
    expect(d.best_raw_inches).toBe(18.5);
    expect(d.zero_point_inches).toBe(15);
    expect(d.score_inches).toBe(3.5);

    const negative = derive(withTest('sit_and_reach', {
      attempts: [{ inches: 10.5, valid: true }], knee_bending: true, bouncing: false, notes: '', completed: true,
    })).tests.sit_and_reach;
    expect(negative.score_inches).toBe(-4.5);
    expect(negative.knee_bending).toBe(true);

    const norm = derive(battery()).tests.sit_and_reach.norm;
    expect(norm).toEqual({ table_version: null, category: null, message: 'Norm classification unavailable' });
  });

  test('refuses a sit and reach with no valid attempt, or with 0 / 4 attempts', () => {
    const allInvalid = protocol.parseRecorded(withTest('sit_and_reach', {
      attempts: [{ inches: 20, valid: false }], knee_bending: false, bouncing: false, notes: '', completed: true,
    }));
    expect(allInvalid.ok).toBe(false);
    expect(allInvalid.message).toMatch(/valid attempt/);

    const none = protocol.parseRecorded(withTest('sit_and_reach', {
      attempts: [], knee_bending: false, bouncing: false, notes: '', completed: true,
    }));
    expect(none.ok).toBe(false);

    const four = protocol.parseRecorded(withTest('sit_and_reach', {
      attempts: [1, 2, 3, 4].map((inches) => ({ inches, valid: true })), knee_bending: false, bouncing: false, notes: '', completed: true,
    }));
    expect(four.ok).toBe(false);
  });

  test('rejects out-of-range and unknown-protocol payloads', () => {
    expect(protocol.parseRecorded(withTest('hamstrings', {
      sides: { left: hamSide({ hip_flexion_deg: 200 }), right: hamSide() }, completed: true,
    })).ok).toBe(false);
    expect(protocol.parseRecorded(withTest('quadriceps', {
      sides: { left: quadSide({ contact: false, distance_cm: 61 }), right: quadSide() }, completed: true,
    })).ok).toBe(false);
    const unknown = protocol.parseRecorded({ protocol_version: 'k11-2099.99', tests: {} });
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toMatch(/k11-2026\.01/);
  });

  test('an unable test completes the assessment only with an explicit override reason', () => {
    const unable = withTest('hamstrings', {
      completed: false, unable_to_complete: true, unable_reason: 'Acute hamstring strain — pain on stretch',
    });
    expect(protocol.validateForStorage(parsed(unable))).toMatch(/override reason/i);

    unable.override = { reason: 'Withheld from the stretch tests on physio advice; other tests recorded' };
    const recorded = parsed(unable);
    expect(protocol.validateForStorage(recorded)).toBeNull();
    const d = protocol.deriveFlexibility(recorded);
    expect(d.override_used).toBe(true);
    expect(d.overall_status).toBe('completed_with_override');
  });

  test('a partially recorded test is not storable, and says which test is missing', () => {
    const partial = withTest('hip_flexors', {
      sides: { left: hipSide(), right: hipSide() }, completed: false,
    });
    const recorded = parsed(partial); // shape is valid; the completion flag is what is missing
    const message = protocol.validateForStorage(recorded);
    expect(message).toMatch(/Still to record: Hip Flexors \(Thomas test\)/);
    expect(protocol.deriveFlexibility(recorded).overall_status).toBe('incomplete');
  });

  test('asymmetry comes from the angle rule or a categorical mismatch', () => {
    const numeric = derive(withTest('hamstrings', {
      sides: { left: hamSide({ hip_flexion_deg: 90 }), right: hamSide({ hip_flexion_deg: 70 }) }, completed: true,
    }));
    expect(numeric.has_asymmetry).toBe(true);

    const within = derive(withTest('hamstrings', {
      sides: { left: hamSide({ hip_flexion_deg: 74 }), right: hamSide({ hip_flexion_deg: 78 }) }, completed: true,
    }));
    expect(within.has_asymmetry).toBe(false);

    const contact = derive(withTest('quadriceps', {
      sides: { left: quadSide({ contact: true }), right: quadSide({ contact: false }) }, completed: true,
    }));
    expect(contact.has_asymmetry).toBe(true);

    const thigh = derive(withTest('hip_flexors', {
      sides: { left: hipSide({ thigh_position: 'below' }), right: hipSide({ thigh_position: 'above' }) }, completed: true,
    }));
    expect(thigh.has_asymmetry).toBe(true);
  });

  test('empty input derives an incomplete battery instead of throwing', () => {
    const d = protocol.deriveFlexibility({});
    expect(d.overall_status).toBe('incomplete');
    expect(d.override_used).toBe(false);
    expect(d.has_asymmetry).toBe(false);
    expect(d.tests.sit_and_reach.best_raw_inches).toBeNull();
  });
});

describe('K11 stored payload', () => {
  test('stamps the assessor and round-trips byte-identically on an unrelated edit', () => {
    const recorded = parsed(battery());
    const stored = protocol.assembleStored(recorded, {
      userId: 'u1', now: new Date('2026-10-19T05:00:00.000Z'),
    });
    expect(stored.assessor_id).toBe('u1');
    expect(stored.recorded_at).toBe('2026-10-19T05:00:00.000Z');
    expect(stored.override).toEqual({ used: false, reason: null, by: null, at: null });

    const first = JSON.stringify(stored);
    const again = protocol.assembleStored(parsed(JSON.parse(first)), {
      userId: 'u9', prev: stored, now: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(JSON.stringify(again)).toBe(first);
    expect(again.assessor_id).toBe('u1');
    expect(again.recorded_at).toBe('2026-10-19T05:00:00.000Z');
  });

  test('an override is stamped once and preserved on later edits', () => {
    const input = withTest('hamstrings', {
      completed: false, unable_to_complete: true, unable_reason: 'Acute hamstring strain',
    });
    input.override = { reason: 'Physio advice — other tests recorded' };
    const first = protocol.assembleStored(parsed(input), {
      userId: 'u1', now: new Date('2026-10-19T05:00:00.000Z'),
    });
    expect(first.override).toMatchObject({ used: true, by: 'u1', at: '2026-10-19T05:00:00.000Z' });
    expect(first.overall_status).toBe('completed_with_override');

    const again = protocol.assembleStored(parsed(JSON.parse(JSON.stringify(first))), {
      userId: 'u9', prev: first, now: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
  });

  test('legacy blobs are not mistaken for the recorded battery', () => {
    expect(protocol.isRecordedBattery({ test1: { testType: 'Sit and Reach', score: 4 } })).toBe(false);
    expect(protocol.isRecordedBattery(null)).toBe(false);
    expect(protocol.isRecordedBattery(battery())).toBe(true);
  });
});
