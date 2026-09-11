'use strict';
// One session model per responsibility.
//
// ── What the three tables actually were ────────────────────────────────────
//
// pt_sessions        a scheduled PT appointment: starts_at/ends_at, a weekly
//                    recurrence_id, trainer payout fields, a rating and the
//                    client's feedback. A calendar row.
//
// workout_sessions   what a client actually did: exercises and sets, through
//                    workout_session_exercises → workout_sets. The pt-os
//                    workout log. CANONICAL.
//
// training_sessions  the same thing as workout_sessions, built again.
//
// The first is a different responsibility and stays. The other two were one
// responsibility with two implementations, and the tie was not broken by
// preference — it was broken by evidence:
//
//   workout_sessions      123 rows,  83 in the last 30 days, newest 2026-09-02
//   training_sessions      48 rows,   8 in the last 30 days, newest 2026-08-14
//   exercise_performances  41 rows,   0 in the last 30 days
//   workout_assignments    49 rows  ·  training_assignments 0 rows
//
//   training_sessions      48 of 48 carried metadata->>'migrated_from'
//   exercise_performances  41 of 41 carried metadata->>'migrated_from'
//   set_performances      100 of 100 carried client_token LIKE 'legacy:%'
//
// Not one row on the training side was created by its own API. Migration 167
// copied them in from workout_sessions, server.js promised a cutover ("slice G
// repoints the old path once nothing reads it"), and the cutover never came —
// while the table it copied FROM kept taking every real session. The frontend
// agreed: the page calling /api/training/sessions existed and nothing in the
// app navigated to it.
//
// So this is not a merge. It is one system and one staging copy of it, and
// migration 193 moved the copy to the `archive` schema with every row intact.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/**
 * The tables migrations 193 and 195 moved out of `public`.
 *
 * 193 took the session half on the evidence above. 195 took the prescription
 * half — training_programs → phases → weeks → workout_templates →
 * workout_template_exercises — on evidence of the same shape and one extra
 * fact that settled it: once 193 archived training_assignments, nothing
 * downstream could assign or log a template, so the authoring half had no path
 * to a client at all. It held 0 programmes and 1 template whose four
 * prescriptions were the builder's untouched defaults, one of them a treadmill
 * run stored as WEIGHT_REPS 3×10 — the exact shape migration 164 was written
 * to abolish.
 */
const ARCHIVED = [
  'training_sessions', 'exercise_performances', 'set_performances',
  'cardio_performances', 'personal_records', 'training_assignments',
  'training_programs', 'training_program_phases', 'training_program_weeks',
  'workout_templates', 'workout_template_exercises',
];

/** Runtime .js under src/, excluding tests and migrations. */
function runtimeFiles(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations' || e.name === 'node_modules') continue;
      runtimeFiles(full, out);
    } else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = runtimeFiles();

/** Statements naming a table, as "file:line  text". Comments included on
 *  purpose — a commented-out query is still a query waiting to be restored. */
function offenders(table) {
  const re = new RegExp(`\\b(?:FROM|UPDATE|INTO|JOIN)\\s+(?:public\\.)?${table}\\b`, 'i');
  const found = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line)) found.push(`${path.relative(SRC, f)}:${i + 1}  ${line.trim()}`);
    });
  }
  return found;
}

describe('the archived training-session tables have no runtime reader', () => {
  it('scans a real set of runtime files', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(path.join('routes', 'workouts.js')))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join('modules', 'pt-os', 'workout-log.routes.js')))).toBe(true);
  });

  it.each(ARCHIVED)('no runtime file queries %s', (table) => {
    expect(offenders(table)).toEqual([]);
  });

  it('the modules that implemented the retired half are gone', () => {
    // training.service.js owned the session lifecycle; records.js and volume.js
    // existed only to serve it. Asserted as absence rather than as "nothing
    // requires them", because an unreferenced file gets referenced again.
    for (const f of ['training.service.js', 'records.js', 'volume.js']) {
      expect(fs.existsSync(path.join(SRC, 'modules', 'training', f))).toBe(false);
    }
    // …and so is the script that rebuilt personal_records from that history.
    expect(fs.existsSync(path.join(SRC, '..', 'scripts', 'backfill-training-records.js'))).toBe(false);
  });
});

describe('the canonical models survive, and stay distinct', () => {
  it('the pt-os workout log still reads workout_sessions', () => {
    // The negative assertions above are also satisfied by deleting both
    // subsystems. This is what separates "consolidated" from "deleted".
    const log = fs.readFileSync(
      path.join(SRC, 'modules', 'pt-os', 'workout-log.routes.js'), 'utf8');
    // \b matters: without it `workout_sessions_x` satisfies this, so renaming
    // the canonical table out from under the log would pass. (`_` is a word
    // character, so the boundary refuses the suffixed name.)
    expect(log).toMatch(/INSERT INTO workout_sessions\b/i);
    expect(log).toMatch(/FROM workout_sessions\b/i);
    expect(log).toMatch(/\bworkout_session_exercises\b/);
  });

  it('pt_sessions is still the appointment model, and is not a workout log', () => {
    // The third table is a different responsibility, not a third copy. If a
    // future change starts logging exercises against it, this notices.
    const ptos = fs.readFileSync(
      path.join(SRC, 'modules', 'pt-os', 'pt-os.routes.js'), 'utf8');
    expect(ptos).toMatch(/INSERT INTO pt_sessions\b/i);
    // Tied to the INSERT's own column list. A bare /recurrence_id/ also
    // matches the handler variable above it, so dropping the column from the
    // write — the two models converging — went unnoticed.
    expect(ptos).toMatch(/INSERT INTO pt_sessions[\s\S]{0,300}?recurrence_id, organization_id\)/i);
    expect(ptos).not.toMatch(/INSERT INTO pt_sessions[\s\S]{0,400}?exercise/i);
  });

  it('the /api/workouts prescription API is the only one mounted', () => {
    const server = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
    // The survivor. Asserted on the mount rather than on the router file, so
    // deleting the mount while leaving routes/workouts.js on disk still fails.
    expect(server).toMatch(/app\.use\('\/api\/workouts',/);
    expect(server).toMatch(/app\.use\('\/api\/exercises',/);
    // Both halves of the training domain are retired, so nothing should mount
    // its router — and the router itself should not exist to be mounted.
    expect(server).not.toMatch(/app\.use\('\/api\/training'/);
    for (const f of ['training.routes.js', 'training.repository.js', 'training.schemas.js',
                     'prescription.js', 'progression.js', 'units.js']) {
      expect(fs.existsSync(path.join(SRC, 'modules', 'training', f))).toBe(false);
    }
  });

  it('authz.js survives, without its archived-table loader', () => {
    // The one file left in modules/training, and it was never about training:
    // orgWhere/trainerWhere/canAccessClient are the shared fix for the trainer
    // fall-through that has been written by hand four times (see
    // trainerFallthrough.authz.test.js). loadOwned went with the routes — its
    // whole allow-list is in the archive schema now, so it could only throw.
    const authz = fs.readFileSync(
      path.join(SRC, 'modules', 'training', 'authz.js'), 'utf8');
    expect(authz).toMatch(/exports = \{[\s\S]*canAccessClient/);
    expect(authz).not.toMatch(/^async function loadOwned/m);
    expect(require('../modules/training/authz').loadOwned).toBeUndefined();
  });

  it('migration 195 refuses to archive a programme somebody actually built', () => {
    const mig = fs.readFileSync(
      path.join(SRC, 'db', 'migrations', '195_archive_training_program_tables.sql'), 'utf8');

    // Same shape as 193's guard below: pinned to the abort, and counted, so a
    // check downgraded to a notice fails here rather than archiving anyway.
    const guard = mig.slice(0, mig.indexOf('CREATE SCHEMA'));
    const aborts = guard.match(/RAISE EXCEPTION\s*\n?\s*'195 refused/g) || [];
    expect(aborts).toHaveLength(2);
    expect(mig).toMatch(/SET SCHEMA archive/);
    expect(mig).not.toMatch(/DROP TABLE/i);
    // The canonical chain is verified by the migration itself, not assumed.
    expect(mig).toMatch(/workout_plans/);
    expect(mig).toMatch(/workout_sets/);
  });

  it('migration 193 refuses to archive a training domain that is genuinely in use', () => {
    const mig = fs.readFileSync(
      path.join(SRC, 'db', 'migrations', '193_archive_training_session_tables.sql'), 'utf8');

    // Pinned to the guard's own abort rather than to any RAISE in the file:
    // the file raises for several reasons, so a loose assertion would survive
    // the provenance check being downgraded and the tables moving anyway.
    const guard = mig.slice(mig.indexOf('migrated_from'), mig.indexOf('CREATE SCHEMA'));
    // Counted, not merely matched. The guard block raises for four separate
    // reasons — three provenance checks and the external-FK check — so a
    // single `toMatch` stayed green while one of them was downgraded to a
    // notice and that table archived regardless.
    const aborts = guard.match(/RAISE EXCEPTION\s*\n?\s*'193 refused/g) || [];
    expect(aborts).toHaveLength(4);
    expect(mig).toMatch(/SET SCHEMA archive/);
    // Archived, never dropped — the whole point is that the rows survive.
    expect(mig).not.toMatch(/DROP TABLE/i);
  });
});
