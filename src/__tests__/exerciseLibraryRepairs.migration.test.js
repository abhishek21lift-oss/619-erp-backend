'use strict';
// 288_exercise_library_repairs.sql — the 2026-11-24 audit's data repair.
//
// The migration is deliberately narrow and reversible in the only sense that
// matters here: no row is hard-deleted, and every statement is guarded by the
// value it expects to replace. These tests pin the properties that are easy to
// lose in a later edit:
//
//   1. The duplicate spellings are RETIRED, not erased, and every reference is
//      repointed before the retirement so no plan loses its exercise.
//   2. The retired row's metadata is folded into the surviving row first.
//   3. The target/pattern and equipment repairs move the primary-muscle map
//      with the flat columns; a row that says Chest in one place and Triceps
//      in the other is the same defect one layer down.
//   4. `Ab Roller (Copy)` is untouched: it belongs to a studio, not the shared
//      library, and the owner has not confirmed it is disposable.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(
  __dirname, '..', 'db', 'migrations', '288_exercise_library_repairs.sql',
);
const sql = fs.readFileSync(MIGRATION, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

function valuesRows(block) {
  if (!block) return [];
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('exercise library repairs migration', () => {
  it('retires the no-space duplicates without hard-deleting a row', () => {
    // The library soft-deletes. A hard DELETE here would either fail on the
    // workout_exercises FK or, worse, strip an old plan if that FK changed.
    expect(body).not.toMatch(/DELETE\s+FROM\s+exercises\b/i);
    expect(body).toMatch(
      /UPDATE exercises\s+SET deleted_at = NOW\(\), is_active = FALSE\s+WHERE slug IN \('pullups', 'pushups'\)/i,
    );
  });

  it('repoints references and folds metadata before retiring the duplicate', () => {
    const planRepoint = body.indexOf('UPDATE workout_exercises');
    const sessionRepoint = body.indexOf('UPDATE workout_session_exercises');
    const recentMerge = body.indexOf('INSERT INTO exercise_recent_usage');
    const retire = body.indexOf("UPDATE exercises\nSET deleted_at = NOW()");

    expect(planRepoint).toBeGreaterThan(-1);
    expect(sessionRepoint).toBeGreaterThan(planRepoint);
    expect(recentMerge).toBeGreaterThan(sessionRepoint);
    expect(retire).toBeGreaterThan(recentMerge);

    // The surviving row inherits what only the duplicate knew.
    expect(body).toMatch(/SET force = COALESCE\(keep\.force, dup\.force\)/i);
    expect(body).toMatch(/mechanic = COALESCE\(keep\.mechanic, dup\.mechanic\)/i);
    expect(body).toMatch(/INSERT INTO exercise_muscles[\s\S]*?FROM exercises keep[\s\S]*?JOIN exercises dup ON dup\.slug = 'pullups'/i);
    expect(body).toMatch(/INSERT INTO exercise_muscles[\s\S]*?FROM exercises keep[\s\S]*?JOIN exercises dup ON dup\.slug = 'pushups'/i);

    // One trainer used both spellings, so a plain repoint would collide on the
    // (user_id, exercise_id) primary key. Merge the counts instead.
    expect(body).toMatch(
      /ON CONFLICT \(user_id, exercise_id\) DO UPDATE\s+SET use_count = exercise_recent_usage\.use_count \+ EXCLUDED\.use_count/i,
    );
  });

  it('seeds the old spellings as global aliases, by slug', () => {
    const block = body.match(/FROM \(VALUES([\s\S]*?)\) AS v\(slug, alias\)/i);
    expect(block).not.toBeNull();
    expect(valuesRows(block)).toEqual(['pull-ups', 'Pullups', 'push-ups', 'Pushups']);
    expect(body).toMatch(/INSERT INTO exercise_aliases \(exercise_id, organization_id, alias\)/i);
    expect(body).toMatch(/SELECT e\.id, NULL, v\.alias/i);
    expect(body).toMatch(/ON e\.slug = v\.slug/i);
    expect(body).toMatch(/e\.organization_id IS NULL/i);
  });

  it('repairs the seven target/pattern rows and moves the primary muscle with them', () => {
    const block = body.match(
      /FROM \(VALUES([\s\S]*?)\) AS f\(slug, old_target, new_target, new_group, new_pattern, new_muscle\)\s*JOIN muscles/i,
    );
    expect(block).not.toBeNull();
    const rows = [...block[1].matchAll(/\('([a-z0-9-]+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g)]
      .map((m) => m.slice(1));

    expect(rows).toHaveLength(7);
    expect(rows).toEqual(expect.arrayContaining([
      ['rear-leg-raises', 'Quadriceps', 'Glutes', 'Legs', 'Hinge', 'Glutes'],
      ['side-leg-raises', 'Adductors', 'Abductors', 'Legs', 'Isolation', 'Abductors'],
      ['front-leg-raises', 'Hamstrings', 'Hamstrings', 'Legs', 'Mobility', 'Hamstrings'],
      ['supine-chest-throw', 'Triceps', 'Chest', 'Chest', 'Horizontal Push', 'Chest'],
      ['bench-press-powerlifting', 'Triceps', 'Chest', 'Chest', 'Horizontal Push', 'Chest'],
      ['bench-press-with-chains', 'Triceps', 'Chest', 'Chest', 'Horizontal Push', 'Chest'],
      ['reverse-band-bench-press', 'Triceps', 'Chest', 'Chest', 'Horizontal Push', 'Chest'],
    ]));

    // The flat columns are only half the repair. The muscle map must agree.
    expect(body).toMatch(/DELETE FROM exercise_muscles em\s+WHERE em\.role = 'primary'/i);
    expect(body).toMatch(
      /INSERT INTO exercise_muscles \(exercise_id, muscle_id, role\)[\s\S]*?ON CONFLICT \(exercise_id, muscle_id\) DO UPDATE SET role = 'primary'/i,
    );
    // Deleting the old primary would drop the triceps relationship entirely;
    // keep it as a secondary mover instead.
    expect(body).toMatch(
      /INSERT INTO exercise_muscles \(exercise_id, muscle_id, role\)\s+SELECT e\.id, m\.id, 'secondary'[\s\S]*?JOIN muscles m ON m\.name = 'Triceps'/i,
    );
  });

  it('repairs the six equipment labels and keeps the update idempotent', () => {
    const block = body.match(
      /FROM \(VALUES([\s\S]*?)\) AS f\(slug, old_equipment, new_equipment\)\s*JOIN equipment_types/i,
    );
    expect(block).not.toBeNull();
    const rows = [...block[1].matchAll(/\('([a-z0-9-]+)',\s*'([^']+)',\s*'([^']+)'\)/g)]
      .map((m) => m.slice(1));

    expect(rows).toEqual(expect.arrayContaining([
      ['band-assisted-pull-up', 'Other', 'Resistance Band'],
      ['seated-band-hamstring-curl', 'Other', 'Resistance Band'],
      ['weighted-sit-ups-with-bands', 'Other', 'Resistance Band'],
      ['close-grip-ez-bar-curl', 'Barbell', 'EZ Curl Bar'],
      ['decline-ez-bar-triceps-extension', 'Barbell', 'EZ Curl Bar'],
      ['smith-incline-shoulder-raise', 'Barbell', 'Machine'],
    ]));
    expect(rows).toHaveLength(6);

    // A second run must be a no-op, not a second version of the same edit.
    expect(body).toMatch(/AND e\.target_muscle = f\.old_target/i);
    expect(body).toMatch(/AND e\.equipment = f\.old_equipment/i);
  });

  it('does not touch the custom copy in another studio', () => {
    // `Ab Roller (Copy)` is an org-owned row with no usage. Deleting it from a
    // library-wide migration would be one studio's call made by everyone.
    expect(body.toLowerCase()).not.toContain('ab-roller-copy');
    expect(body.toLowerCase()).not.toContain('ab roller (copy)');
  });
});
