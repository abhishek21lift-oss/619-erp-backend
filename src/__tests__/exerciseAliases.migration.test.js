'use strict';
// 287_exercise_aliases.sql — a synonym is written down, never guessed.
//
// The resolver still matches library names exactly (plan-critic.js measured
// why: trigram similarity files "Overhead Press" under "Overhead Lat"). An
// alias is the one exception, and only after a name miss. Two properties are
// easy to lose in a later edit and invisible in review, so they are pinned
// here:
//
//   1. `normalized` must fold text exactly like normaliseName() in
//      plan-critic.js. If the SQL fold drifts — a stray btrim, a different
//      character class — the row is written and never matched, and the symptom
//      is "the AI used a name we don't have" all over again.
//
//   2. The seed is GLOBAL and joined by slug. Joining by display name would
//      attach an alias to the wrong row when a studio has a custom exercise
//      with the same name; seeding with an organization would make one
//      studio's vocabulary resolve for another. "Bulgarian Split Squat" is
//      deliberately absent: the library has no rear-foot-elevated split
//      squat, and filing it under "Split Squats" would prescribe a different
//      movement. It stays unverified until a trainer creates it.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(
  __dirname, '..', 'db', 'migrations', '287_exercise_aliases.sql',
);
const sql = fs.readFileSync(MIGRATION, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

describe('exercise aliases migration', () => {
  it('normalises an alias with the same fold the resolver uses', () => {
    // plan-critic.normaliseName(): lower, btrim, non-alphanumerics → space,
    // trim. The generated column has to be that, not a LIKE-friendly variant.
    expect(body).toMatch(
      /normalized\s+TEXT GENERATED ALWAYS AS \(\s*btrim\(regexp_replace\(lower\(btrim\(alias\)\), '\[\^a-z0-9\]\+', ' ', 'g'\)\)\s*\) STORED/i,
    );
  });

  it('allows one spelling per scope, including the global scope', () => {
    // A plain UNIQUE on (organization_id, normalized) does not constrain the
    // NULL-org rows, because Postgres treats NULLs as distinct.
    expect(body).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS exercise_aliases_global_key\s+ON exercise_aliases \(normalized\)\s+WHERE organization_id IS NULL/i,
    );
    expect(body).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS exercise_aliases_org_key\s+ON exercise_aliases \(organization_id, normalized\)\s+WHERE organization_id IS NOT NULL/i,
    );
  });

  it('ships the RLS shape the platform roles rely on', () => {
    expect(body).toMatch(/ALTER TABLE exercise_aliases ENABLE ROW LEVEL SECURITY/i);
    expect(body).toMatch(/REVOKE ALL ON public\.exercise_aliases FROM anon, authenticated/i);
    expect(body).toMatch(/CREATE POLICY deny_all_direct_access ON public\.exercise_aliases/i);
    // Reading a NULL-org alias is only allowed once a tenant is identified;
    // writing one is never allowed to a tenant.
    expect(body).toMatch(
      /organization_id IS NULL\s+AND NULLIF\(current_setting\('app\.org_id', true\), ''\) IS NOT NULL/i,
    );
  });

  it('seeds only the five written synonyms, globally, by slug', () => {
    const values = body.match(/FROM \(VALUES([\s\S]*?)\) AS v\(slug, alias\)/i);
    expect(values).not.toBeNull();
    const pairs = [...values[1].matchAll(/'([a-z0-9-]+)'\s*,\s*'([^']+)'/g)]
      .map((m) => [m[1], m[2]]);

    expect(pairs).toEqual([
      ['bench-press', 'Barbell Bench Press'],
      ['barbell-squat', 'Barbell Back Squat'],
      ['seated-cable-rows', 'Seated Cable Row'],
      ['lateral-raise', 'Dumbbell Lateral Raise'],
      ['barbell-shoulder-press', 'Overhead Press'],
    ]);

    expect(body).toMatch(/INSERT INTO exercise_aliases \(exercise_id, organization_id, alias\)/i);
    expect(body).toMatch(/SELECT e\.id, NULL, v\.alias/i);
    expect(body).toMatch(/ON e\.slug = v\.slug/i);
    expect(body).toMatch(/e\.organization_id IS NULL/i);

    // The deliberate omission: no library row is a rear-foot-elevated split
    // squat, so this must stay unverified rather than resolve to a different
    // movement. Scoped to the VALUES block so the explanatory comment above
    // may still name it.
    expect(values[1].toLowerCase()).not.toContain('bulgarian');
  });
});
