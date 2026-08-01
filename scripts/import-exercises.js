/**
 * Exercise Library Import Script
 * Imports the free-exercise-db dataset into the exercises table.
 * Usage: node scripts/import-exercises.js
 *
 * Imported rows are PLATFORM library rows: organization_id stays NULL, so
 * every studio sees them and none can edit them in place (a studio that wants
 * its own version duplicates it — see modules/exercises).
 *
 * Slug, category and search_keywords are generated here as well as in
 * migration 141. The migration backfills what already existed; this covers
 * everything imported afterwards, which would otherwise arrive with a NULL
 * slug and be invisible to slug lookup and full-text search.
 *
 * Note on 'Neck': BODY_PART_MAP maps a primary muscle of `neck` to 'Neck',
 * which the muscle_group CHECK constraint rejected until migration 141 added
 * it. Before that migration every neck exercise failed its INSERT and was
 * counted as "skipped" with no visible explanation.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const pool = require('../src/db/pool');

const BODY_PART_MAP = {
  abdominals:   'Core',
  obliques:     'Core',
  hamstrings:   'Legs',
  adductors:    'Legs',
  quadriceps:   'Legs',
  glutes:       'Legs',
  calves:       'Legs',
  abductors:    'Legs',
  biceps:       'Arms',
  triceps:      'Arms',
  forearms:     'Arms',
  shoulders:    'Shoulders',
  chest:        'Chest',
  'middle back':'Back',
  'lower back': 'Back',
  lats:         'Back',
  traps:        'Back',
  neck:         'Neck',
};

const EQUIPMENT_MAP = {
  'body only':    'Bodyweight',
  machine:        'Machine',
  dumbbell:       'Dumbbell',
  barbell:        'Barbell',
  kettlebells:    'Kettlebell',
  cable:          'Cable',
  bands:          'Resistance Band',
  'exercise ball':'Exercise Ball',
  'foam roll':    'Foam Roller',
  'medicine ball':'Medicine Ball',
  'e-z curl bar': 'EZ Curl Bar',
  other:          'Other',
};

const DIFFICULTY_MAP = {
  beginner:     'beginner',
  intermediate: 'intermediate',
  expert:       'advanced',
};

const BASE_IMAGE_URL = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises';

function normalize(ex) {
  const primaryMuscle = (ex.primaryMuscles || [])[0] || '';
  const bodyPart = BODY_PART_MAP[primaryMuscle] || 'Full Body';
  const equipment = EQUIPMENT_MAP[ex.equipment] || ex.equipment || null;
  const difficulty = DIFFICULTY_MAP[ex.level] || ex.level || 'beginner';
  const instructions = Array.isArray(ex.instructions) ? ex.instructions.join('\n') : null;
  const secondaryMuscles = Array.isArray(ex.secondaryMuscles) && ex.secondaryMuscles.length
    ? ex.secondaryMuscles.join(', ')
    : null;
  const gifUrl = Array.isArray(ex.images) && ex.images.length
    ? `${BASE_IMAGE_URL}/${ex.images[0]}`
    : null;
  const name = ex.name.trim();
  const capitalName = name.charAt(0).toUpperCase() + name.slice(1);

  return {
    source_id:         ex.id,
    name:              capitalName,
    muscle_group:      bodyPart,
    body_part:         bodyPart,
    target_muscle:     primaryMuscle,
    secondary_muscles: secondaryMuscles,
    equipment,
    difficulty,
    instructions,
    gif_url:           gifUrl,
    exercise_type:     ex.category || null,
    force:             ex.force || null,
    mechanic:          ex.mechanic || null,
  };
}

/**
 * Category, derived the same way migration 141 derives it for existing rows,
 * so an imported exercise and a backfilled one land in the same bucket.
 */
function categoryFor(n) {
  const t = String(n.exercise_type || '').toLowerCase();
  if (t.includes('stretch')) return 'Flexibility';
  if (t.includes('cardio')) return 'Cardio';
  if (t.includes('plyo')) return 'Plyometric';
  if (t.includes('olympic')) return 'Olympic';
  if (t.includes('powerlifting')) return 'Powerlifting';
  if (t.includes('strongman')) return 'Strongman';
  if (n.muscle_group === 'Cardio') return 'Cardio';
  return 'Strength';
}

/** The facet terms a trainer would search by. Mirrors the service's version. */
function buildSearchKeywords(n) {
  const seen = new Set();
  for (const raw of [n.target_muscle, n.muscle_group, n.body_part, n.equipment,
    n.exercise_type, n.force, n.mechanic, categoryFor(n)]) {
    if (raw == null) continue;
    const v = String(raw).trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen];
}

const slugify = (name) => String(name || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** A slug nothing else holds. The unique index is partial on deleted_at. */
async function uniqueSlug(name) {
  const base = slugify(name) || 'exercise';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const { rows } = await pool.query(
      'SELECT 1 FROM exercises WHERE slug = $1 AND deleted_at IS NULL LIMIT 1',
      [candidate]
    );
    if (!rows[0]) return candidate;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

async function run() {
  const rawPath = path.join(__dirname, '..', '..', 'exercises_raw.json');
  if (!fs.existsSync(rawPath)) {
    console.error('exercises_raw.json not found at:', rawPath);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  console.log(`Loaded ${raw.length} exercises from dataset`);

  // Build name → id map of existing exercises
  const { rows: existing } = await pool.query(
    'SELECT id, name, source_id FROM exercises'
  );
  const byName      = new Map(existing.map(r => [r.name.toLowerCase(), r.id]));
  const bySourceId  = new Map(existing.map(r => [r.source_id, r.id]).filter(([k]) => k));

  let inserted = 0, updated = 0, skipped = 0;
  const errors = [];

  for (const ex of raw) {
    const n = normalize(ex);
    try {
      const existingBySourceId = bySourceId.get(n.source_id);
      const existingByNameId   = byName.get(n.name.toLowerCase());
      const existingId = existingBySourceId || existingByNameId;

      if (existingId) {
        // Update: add new enrichment fields, don't overwrite manually-set fields
        await pool.query(`
          UPDATE exercises SET
            source_id         = COALESCE(source_id, $1),
            body_part         = $2,
            target_muscle     = $3,
            secondary_muscles = $4,
            equipment         = COALESCE($5, equipment),
            instructions      = COALESCE($6, instructions),
            gif_url           = COALESCE($7, gif_url),
            exercise_type     = COALESCE($8, exercise_type),
            force             = COALESCE($9, force),
            mechanic          = COALESCE($10, mechanic),
            muscle_group      = COALESCE(muscle_group, $11),
            updated_at        = NOW()
          WHERE id = $12
        `, [
          n.source_id, n.body_part, n.target_muscle, n.secondary_muscles,
          n.equipment, n.instructions, n.gif_url, n.exercise_type,
          n.force, n.mechanic, n.muscle_group, existingId,
        ]);
        updated++;
      } else {
        // Slug and search keywords are generated here rather than left for
        // migration 141's backfill: that runs once, so anything imported
        // afterwards would arrive with a NULL slug and be invisible to
        // lookup-by-slug and to full-text search.
        const slug = await uniqueSlug(n.name);
        await pool.query(`
          INSERT INTO exercises
            (id, name, muscle_group, body_part, target_muscle, secondary_muscles,
             equipment, difficulty, instructions, gif_url, exercise_type,
             force, mechanic, source_id, slug, category, search_keywords, is_active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true)
        `, [
          randomUUID(), n.name, n.muscle_group, n.body_part, n.target_muscle,
          n.secondary_muscles, n.equipment, n.difficulty, n.instructions,
          n.gif_url, n.exercise_type, n.force, n.mechanic, n.source_id,
          slug, categoryFor(n), buildSearchKeywords(n),
        ]);
        inserted++;
        byName.set(n.name.toLowerCase(), 'new');
        bySourceId.set(n.source_id, 'new');
      }
    } catch (err) {
      errors.push({ name: n.name, error: err.message });
      skipped++;
    }
  }

  console.log('\n=== Exercise Import Complete ===');
  console.log(`  Inserted : ${inserted}`);
  console.log(`  Updated  : ${updated}`);
  console.log(`  Skipped  : ${skipped}`);
  console.log(`  Total    : ${raw.length}`);

  if (errors.length) {
    console.log('\nErrors:');
    errors.slice(0, 20).forEach(e => console.log(`  ${e.name}: ${e.error}`));
  }

  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*) FROM exercises');
  console.log(`\nTotal exercises in DB: ${count}`);
  await pool.end();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  pool.end().finally(() => process.exit(1));
});
