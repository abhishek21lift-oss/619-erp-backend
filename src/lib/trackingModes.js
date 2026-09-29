'use strict';
// How an exercise is measured — the vocabulary of exercises.prescription_mode_*
// (migrations 174 and 221). One list, so the editor's validation and the
// database CHECK cannot drift apart.
//
// NULL is a legitimate value and means "legacy": the exercise is treated as
// WEIGHT_REPS, which is how every exercise behaved before modes existed.

const TRACKING_MODES = Object.freeze([
  'WEIGHT_REPS', 'BODYWEIGHT', 'REPS', 'HOLD',
  'TIME', 'DISTANCE', 'SPEED', 'PACE', 'TIME_SPEED', 'TIME_DISTANCE',
  'DISTANCE_LOAD', 'TIME_LOAD', 'CALORIES', 'HEART_RATE', 'RPE', 'INTERVAL',
  'ROUNDS', 'RPM', 'STEPS', 'FLOORS',
]);

const MODE_SET = new Set(TRACKING_MODES);

class TrackingModeError extends Error {}

/**
 * Normalises the two editor fields. `undefined` means "not sent" and is
 * passed through so a partial update leaves the column alone.
 *
 * The primary mode is always part of the allowed list when both are sent: an
 * exercise cannot be tracked by default in a way the trainer may not pick.
 *
 * @returns {{ primary: string|null|undefined, allowed: string[]|undefined }}
 * @throws {TrackingModeError} on an unknown mode
 */
function normaliseTrackingModes(primaryInput, allowedInput) {
  let primary;
  if (primaryInput !== undefined) {
    primary = primaryInput === null || primaryInput === '' ? null : String(primaryInput).toUpperCase();
    if (primary !== null && !MODE_SET.has(primary)) {
      throw new TrackingModeError(`Unknown tracking mode: ${primaryInput}`);
    }
  }

  let allowed;
  if (allowedInput !== undefined) {
    if (allowedInput !== null && !Array.isArray(allowedInput)) {
      throw new TrackingModeError('prescription_mode_allowed must be an array');
    }
    allowed = [];
    for (const raw of allowedInput || []) {
      const m = String(raw).toUpperCase();
      if (!MODE_SET.has(m)) throw new TrackingModeError(`Unknown tracking mode: ${raw}`);
      if (!allowed.includes(m)) allowed.push(m);
    }
  }

  // When only the primary is sent, `allowed` stays undefined: a create fills
  // it with [primary], an update prepends the primary in SQL so the options
  // the exercise already had are not thrown away.
  if (primary && allowed !== undefined && !allowed.includes(primary)) allowed.unshift(primary);

  return { primary, allowed };
}

module.exports = { TRACKING_MODES, TrackingModeError, normaliseTrackingModes };
