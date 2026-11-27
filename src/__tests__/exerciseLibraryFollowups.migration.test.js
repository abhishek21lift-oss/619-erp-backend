'use strict';
// 289_exercise_library_followups.sql — the post-deploy follow-up.
//
// These tests pin the properties that are easy to lose in a later edit:
//
//   1. The legacy secondary text is rebuilt from the structured map, and a
//      row with no secondary movers ends up NULL rather than repeating its
//      primary. The comparison is set-based, so cosmetic case/order changes
//      do not rewrite the whole library.
//   2. Both retired spellings have their references carried, not just
//      `pushups`, and the recent-use counts merge instead of colliding.
//   3. The equipment relabel only touches rows whose old label is the one the
//      migration expects, moves `equipment` and `equipment_id` together, and
//      leaves genuine odd equipment (stones, sleds, yokes) as `Other`.
//   4. `Ab Roller (Copy)` is untouched and no exercise row is hard-deleted.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(
  __dirname, '..', 'db', 'migrations', '289_exercise_library_followups.sql'
);
const sql = fs.readFileSync(MIGRATION, 'utf8');

/** Strip line comments so an assertion cannot match prose. */
const body = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

describe('289 exercise-library follow-ups', () => {
  it('rebuilds the legacy secondary text from the map, set-wise', () => {
    expect(body).toMatch(/WITH mismatched AS/i);
    expect(body).toMatch(/e\.organization_id IS NULL/i);
    expect(body).toMatch(/array_agg\(DISTINCT lower\(trim\(x\)\) ORDER BY lower\(trim\(x\)\)\)/i);
    expect(body).toMatch(/array_agg\(DISTINCT lower\(m\.name\) ORDER BY lower\(m\.name\)\)/i);
    expect(body).toMatch(/IS DISTINCT FROM/i);
    expect(body).toMatch(/SET secondary_muscles = \(/i);
    // A map with no secondary rows must produce NULL, not the primary name.
    expect(body).toMatch(/string_agg\(lower\(m\.name\), ', ' ORDER BY m\.name\)/i);
  });

  it('carries references for both retired spellings', () => {
    expect(body).toMatch(/\('pullups', 'pull-ups'\)/i);
    expect(body).toMatch(/\('pushups', 'push-ups'\)/i);
    expect(body).toMatch(/UPDATE workout_exercises we/i);
    expect(body).toMatch(/UPDATE workout_session_exercises wse/i);
    expect(body).toMatch(/INSERT INTO exercise_recent_usage/i);
    expect(body).toMatch(/ON CONFLICT \(user_id, exercise_id\) DO UPDATE/i);
    expect(body).toMatch(/DELETE FROM exercise_recent_usage r/i);
  });

  it('relabels only unambiguous equipment and moves the id with the text', () => {
    expect(body).toMatch(/SET equipment = f\.new_equipment,\s*equipment_id = f\.new_equipment_id/i);
    expect(body).toMatch(/e\.equipment = f\.old_equipment/i);
    expect(body).toMatch(/\('trap-bar-deadlift',\s*'Other',\s*'Trap Bar'\)/i);
    expect(body).toMatch(/\('suspended-row',\s*'Other',\s*'Suspension Trainer'\)/i);
    expect(body).toMatch(/\('anterior-tibialis-smr',\s*'Other',\s*'Foam Roller'\)/i);
    expect(body).toMatch(/\('dips-chest-version',\s*'Other',\s*'Bodyweight'\)/i);
    expect(body).toMatch(/\('donkey-calf-raises',\s*'Other',\s*'Machine'\)/i);
  });

  it('leaves genuine odd equipment as Other', () => {
    for (const slug of ['atlas-stones', 'yoke-walk', 'sled-push', 'tire-flip', 'battling-ropes']) {
      expect(body).not.toMatch(new RegExp(`\\('${slug}',\\s*'Other'`, 'i'));
    }
  });

  it('moves the exercise-ball crunch off Bodyweight', () => {
    expect(body).toMatch(/e\.slug = 'crunch-legs-on-exercise-ball'/i);
    expect(body).toMatch(/e\.equipment = 'Bodyweight'/i);
    expect(body).toMatch(/SET equipment = 'Exercise Ball'/i);
  });

  it('does not touch the custom copy or hard-delete an exercise', () => {
    expect(body).not.toMatch(/ab-roller-copy/i);
    expect(body).not.toMatch(/DELETE FROM exercises/i);
    expect(body).not.toMatch(/TRUNCATE/i);
  });
});
