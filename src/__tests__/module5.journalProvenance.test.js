'use strict';

const { deriveProvenance } = require('../modules/progress/journal-provenance');

describe('Module 5 journal provenance', () => {
  const imported = {
    steps: 9000, steps_source: 'imported', sleep_hours: null, water_ml: null,
    sleep_quality: null, electrolytes: null, stress_level: null, energy_level: null,
    fatigue_level: null, soreness_level: null, recovery_level: null,
  };

  it('keeps imported provenance when only notes change', () => {
    const values = { notes: 'late walk' };
    const merged = { ...imported, ...values };
    expect(deriveProvenance(imported, values, merged)).toEqual({
      steps_source: 'imported', source: 'imported',
    });
  });

  it('marks a hand-edited step count manual', () => {
    const values = { steps: 8500 };
    const merged = { ...imported, ...values };
    expect(deriveProvenance(imported, values, merged)).toEqual({
      steps_source: 'manual', source: 'manual',
    });
  });

  it('reports mixed when imported steps coexist with manual sleep', () => {
    const values = { sleep_hours: 7.5 };
    const merged = { ...imported, ...values };
    expect(deriveProvenance(imported, values, merged)).toEqual({
      steps_source: 'imported', source: 'mixed',
    });
  });

  it('does not let a caller claim provenance for a new manual entry', () => {
    const values = { steps: 4000, source: 'imported' };
    expect(deriveProvenance(null, values, values)).toEqual({
      steps_source: 'manual', source: 'manual',
    });
  });
});
