'use strict';
// src/modules/progress/journal-provenance.js
// Where a journal value came from is derived from what was written, never from
// a caller's own `source` claim.

const MANUAL_FIELDS = ['sleep_hours', 'sleep_quality', 'water_ml', 'electrolytes',
  'stress_level', 'energy_level', 'fatigue_level', 'soreness_level', 'recovery_level'];

/**
 * A member route strips `steps_source`, so editing an imported step count by
 * hand turns it back into a manual value; editing only sleep on an imported day
 * leaves the steps labelled imported (or mixed when manual data coexists).
 */
function deriveProvenance(existing, values, merged) {
  const hasSteps = Object.prototype.hasOwnProperty.call(values, 'steps');
  const stepsChanged = hasSteps && values.steps !== (existing?.steps ?? null);
  let stepsSource = existing?.steps_source || null;
  if (merged.steps == null) {
    stepsSource = null;
  } else if (values.steps_source) {
    stepsSource = values.steps_source;
  } else if (hasSteps && (stepsChanged || !stepsSource)) {
    stepsSource = 'manual';
  }
  const manual = MANUAL_FIELDS.some((k) => merged[k] != null);
  const importedSteps = stepsSource === 'wearable' || stepsSource === 'imported';
  const source = importedSteps ? (manual ? 'mixed' : stepsSource) : 'manual';
  return { steps_source: stepsSource, source };
}

module.exports = { deriveProvenance };
