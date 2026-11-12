'use strict';
// D2: proactive AI is off unless the trainer explicitly opted in.
//
// There is no scheduler, no notification and no insight table in Phase 2. This
// is only the predicate a future job must consult, so "default off" is a code
// property rather than a promise in a document.

const {
  PROACTIVE_DEFAULT_ENABLED,
  proactiveEnabled,
} = require('../modules/copilot/proactive/policy');

describe('proactive opt-in', () => {
  test('the product default is off', () => {
    expect(PROACTIVE_DEFAULT_ENABLED).toBe(false);
  });

  test('no preference means off', () => {
    expect(proactiveEnabled(undefined)).toBe(false);
    expect(proactiveEnabled(null)).toBe(false);
    expect(proactiveEnabled({})).toBe(false);
  });

  test('an explicit false is off', () => {
    expect(proactiveEnabled({ proactive_enabled: false })).toBe(false);
  });

  test('only an explicit boolean true turns it on', () => {
    expect(proactiveEnabled({ proactive_enabled: true })).toBe(true);
    expect(proactiveEnabled({ proactive_enabled: 'true' })).toBe(false);
    expect(proactiveEnabled({ proactive_enabled: 1 })).toBe(false);
  });
});
