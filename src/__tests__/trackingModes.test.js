'use strict';
const fs = require('fs');
const path = require('path');
const { TRACKING_MODES, TrackingModeError, normaliseTrackingModes } = require('../lib/trackingModes');

describe('normaliseTrackingModes', () => {
  it('passes "not sent" through untouched so a partial update leaves the columns alone', () => {
    expect(normaliseTrackingModes(undefined, undefined)).toEqual({ primary: undefined, allowed: undefined });
  });

  it('clears the primary with null or an empty string', () => {
    expect(normaliseTrackingModes(null, undefined).primary).toBeNull();
    expect(normaliseTrackingModes('', undefined).primary).toBeNull();
  });

  it('upper-cases, de-duplicates and keeps the primary inside the allowed list', () => {
    expect(normaliseTrackingModes('hold', ['time', 'TIME', 'bodyweight'])).toEqual({
      primary: 'HOLD',
      allowed: ['HOLD', 'TIME', 'BODYWEIGHT'],
    });
  });

  it('leaves allowed undefined when only the primary is sent (the route merges it in SQL)', () => {
    expect(normaliseTrackingModes('DISTANCE_LOAD', undefined)).toEqual({ primary: 'DISTANCE_LOAD', allowed: undefined });
  });

  it.each([
    ['SQUAT', undefined],
    ['HOLD', ['NOPE']],
    ['HOLD', 'HOLD'],
  ])('rejects %p / %p', (primary, allowed) => {
    expect(() => normaliseTrackingModes(primary, allowed)).toThrow(TrackingModeError);
  });
});

describe('tracking-mode vocabulary', () => {
  it('matches the CHECK constraint migration 221 installs', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '221_exercise_tracking_modes.sql'), 'utf8');
    const check = sql.match(/prescription_mode_primary IN \(([\s\S]*?)\)\);/);
    expect(check).not.toBeNull();
    const inDb = [...check[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(inDb).toEqual([...TRACKING_MODES].sort());
  });
});
