// Unit conversion for the training domain.
//
// ── Why nothing is normalised on write ─────────────────────────────────────
//
// The obvious design stores everything in one canonical unit — metres,
// kilograms — and converts on the way out. It is wrong here for a reason that
// only shows up months later: conversion is lossy, and the loss is not
// recoverable.
//
// A studio programming in miles enters 3.1. Stored as 4.98895 km and rendered
// back, it reads 3.1000000000000005 miles, or 3.10 if the formatter rounds —
// and a trainer who typed a round number now sees a number that is almost
// round. Worse, the ROUNDING is baked into history: a mile PR compared against
// a kilometre-normalised value can flip on floating point alone.
//
// So the schema stores the value the human entered, next to the unit they
// entered it in, and this module converts only when two values must be
// compared or summed. The database keeps what was said; arithmetic happens
// here, at the moment it is needed.
//
// Everything is a pure function. No database, no request, no clock.
'use strict';

// ── Weight ─────────────────────────────────────────────────────────────────

const LB_PER_KG = 2.2046226218487757;

const WEIGHT_UNITS = ['kg', 'lb'];

/** Weight in kilograms, whatever it was entered in. */
function toKg(value, unit) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (unit === 'lb') return n / LB_PER_KG;
  return n;
}

function fromKg(kg, unit) {
  if (kg == null) return null;
  const n = Number(kg);
  if (!Number.isFinite(n)) return null;
  return unit === 'lb' ? n * LB_PER_KG : n;
}

// ── Distance ───────────────────────────────────────────────────────────────

const METRES_PER = { m: 1, km: 1000, mile: 1609.344 };

const DISTANCE_UNITS = Object.keys(METRES_PER);

/** Distance in metres. The comparison unit, never a storage unit. */
function toMetres(value, unit) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = METRES_PER[unit];
  if (!factor) return null;
  return n * factor;
}

function fromMetres(metres, unit) {
  if (metres == null) return null;
  const n = Number(metres);
  if (!Number.isFinite(n)) return null;
  const factor = METRES_PER[unit];
  if (!factor) return null;
  return n / factor;
}

// ── Speed ──────────────────────────────────────────────────────────────────
//
// Four units, and two of them are inverted: km/h and mph go up as you get
// faster, min/km and min/mile go DOWN. Treating them as one scale is how a
// "fastest pace" leaderboard ends up sorted backwards, so the inversion is
// handled here once rather than at each call site.

const SPEED_UNITS = ['kmh', 'mph', 'min_per_km', 'min_per_mile'];

/** True when a smaller number means faster. */
function isInvertedSpeed(unit) {
  return unit === 'min_per_km' || unit === 'min_per_mile';
}

/** Speed in metres per second, from any of the four units. */
function toMetresPerSecond(value, unit) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n) || n <= 0) return null;
  switch (unit) {
    case 'kmh':  return n * 1000 / 3600;
    case 'mph':  return n * METRES_PER.mile / 3600;
    // n is minutes per unit distance, so the unit distance takes n*60 seconds.
    case 'min_per_km':   return METRES_PER.km / (n * 60);
    case 'min_per_mile': return METRES_PER.mile / (n * 60);
    default: return null;
  }
}

/**
 * Average speed from a distance and a duration.
 *
 * Returns null rather than Infinity for a zero duration — a 5 km run recorded
 * with no elapsed time is missing data, not infinitely fast, and Infinity
 * propagates into every average it touches.
 */
function averageSpeedMps(distance, distanceUnit, durationSeconds) {
  const metres = toMetres(distance, distanceUnit);
  const secs = Number(durationSeconds);
  if (metres == null || !Number.isFinite(secs) || secs <= 0) return null;
  return metres / secs;
}

// ── Pace ───────────────────────────────────────────────────────────────────

/**
 * Seconds per `paceDistance` of `distanceUnit`.
 *
 * Rowers say 2:00/500m and runners say 5:30/km; both are "seconds to cover a
 * reference distance", so one function serves both and the reference is an
 * argument rather than an assumption.
 */
function paceSeconds(distance, distanceUnit, durationSeconds, paceDistance) {
  const metres = toMetres(distance, distanceUnit);
  const refMetres = toMetres(paceDistance, distanceUnit);
  const secs = Number(durationSeconds);
  if (metres == null || refMetres == null || refMetres <= 0) return null;
  if (!Number.isFinite(secs) || secs <= 0 || metres <= 0) return null;
  return (secs / metres) * refMetres;
}

/** "5:30" from 330. Minutes and seconds, because nobody reads pace in seconds. */
function formatPace(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return null;
  const total = Math.round(n);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** "1:05:30" or "25:00". Hours only when there are any. */
function formatDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return null;
  const total = Math.round(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Rounding ───────────────────────────────────────────────────────────────

/**
 * Round a working weight to something that exists in a gym.
 *
 * A progression rule that says "add 2.5%" produces 83.7375 kg, which no plate
 * arrangement makes. The default increment is 2.5 kg (the smallest pair of
 * plates most gyms stock) and 5 lb for imperial, but a studio with microplates
 * can pass its own.
 */
function roundToIncrement(value, increment) {
  const n = Number(value);
  const inc = Number(increment);
  if (!Number.isFinite(n) || !Number.isFinite(inc) || inc <= 0) return null;
  return Math.round(n / inc) * inc;
}

const DEFAULT_INCREMENT = { kg: 2.5, lb: 5 };

function defaultIncrement(unit) {
  return DEFAULT_INCREMENT[unit] ?? DEFAULT_INCREMENT.kg;
}

module.exports = {
  WEIGHT_UNITS, DISTANCE_UNITS, SPEED_UNITS,
  LB_PER_KG, METRES_PER,
  toKg, fromKg,
  toMetres, fromMetres,
  toMetresPerSecond, averageSpeedMps, isInvertedSpeed,
  paceSeconds, formatPace, formatDuration,
  roundToIncrement, defaultIncrement, DEFAULT_INCREMENT,
};
