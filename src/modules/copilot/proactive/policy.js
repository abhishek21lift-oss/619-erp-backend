'use strict';
// D2, in code: proactive AI is opt-in, default off.
//
// Phase 2 ships no scheduled analysis and no notification. When the proactive
// engine arrives it must call this predicate before evaluating or delivering
// anything; a truthy string or a numeric 1 from an old client is not consent.

const PROACTIVE_DEFAULT_ENABLED = false;

function proactiveEnabled(preference) {
  return preference?.proactive_enabled === true;
}

module.exports = { PROACTIVE_DEFAULT_ENABLED, proactiveEnabled };
