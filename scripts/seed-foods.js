'use strict';
// Import the IFCT 2017 and INDB Indian food datasets into the global foods
// reference (organization_id IS NULL). Re-running is a no-op.
//
//   node scripts/seed-foods.js
//
// Sources (workspace root):
//   data/ifct2017/compositions.csv  IFCT 2017, 542 foods, energy in kJ/100 g
//   data/indb.csv                   INDB, 1,014 recipes, energy in kcal/100 g

const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');
const { normaliseFoodName } = require('../src/modules/nutrition/food-reference');

const DATA_DIR = process.env.FOOD_DATA_DIR
  || [path.resolve(__dirname, '../data'), path.resolve(__dirname, '../../data')]
    .find((dir) => fs.existsSync(path.join(dir, 'indb.csv')));
const BATCH = 200;

if (!DATA_DIR) {
  throw new Error('Food data not found: set FOOD_DATA_DIR or place indb.csv in data/.');
}

if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_FOOD_SEED) {
  throw new Error('Refusing to seed a production database without ALLOW_FOOD_SEED=1');
}

/** RFC 4180 parser: quoted fields, escaped quotes, CRLF, commas in names. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** CSV rows → objects keyed by header. */
function records(file) {
  const [header, ...body] = parseCsv(fs.readFileSync(file, 'utf8'));
  return body
    .filter((row) => row.length > 1)
    .map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])));
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Missing or non-numeric → 0, per the import contract. */
function num(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function ifctFoods() {
  return records(path.join(DATA_DIR, 'ifct2017/compositions.csv')).map((r) => ({
    id: `food-ifct-${r.code}`,
    name: r.name.trim(),
    normalized_name: normaliseFoodName(r.name),
    local_names: String(r.lang || '').split(';').map((s) => s.trim().replace(/\.$/, '')).filter(Boolean),
    category: r.grup || null,
    source: 'ifct2017',
    serving_unit: 'g',
    serving_grams: 100,
    calories: round1(num(r.enerc) / 4.184),
    protein_g: round1(num(r.protcnt)),
    carbs_g: round1(num(r.choavldf)),
    fats_g: round1(num(r.fatce)),
    fiber_g: round1(num(r.fibtg)),
    household_serving: null,
    culture: 'indian',
  }));
}

function indbFoods() {
  return records(path.join(DATA_DIR, 'indb.csv')).map((r) => ({
    id: `food-indb-${r.food_code}`,
    name: r.food_name.trim(),
    normalized_name: normaliseFoodName(r.food_name),
    local_names: [],
    category: null,
    source: 'indb',
    serving_unit: 'g',
    serving_grams: 100,
    calories: round1(num(r.energy_kcal)),
    protein_g: round1(num(r.protein_g)),
    carbs_g: round1(num(r.carb_g)),
    fats_g: round1(num(r.fat_g)),
    fiber_g: round1(num(r.fibre_g)),
    household_serving: r.servings_unit ? `1 ${r.servings_unit.trim()}` : null,
    culture: 'indian',
  }));
}

const COLUMNS = [
  'id', 'name', 'normalized_name', 'local_names', 'category', 'source',
  'serving_unit', 'serving_grams', 'calories', 'protein_g', 'carbs_g',
  'fats_g', 'fiber_g', 'household_serving', 'culture',
];

async function insertAll(client, foods) {
  let inserted = 0;
  for (let start = 0; start < foods.length; start += BATCH) {
    const batch = foods.slice(start, start + BATCH);
    const values = [];
    const params = [];
    batch.forEach((food, row) => {
      values.push(`(${COLUMNS.map((_, col) => `$${row * COLUMNS.length + col + 1}`).join(',')})`);
      params.push(...COLUMNS.map((col) => food[col]));
    });
    const { rowCount } = await client.query(
      `INSERT INTO foods (${COLUMNS.join(', ')})
       VALUES ${values.join(',')}
       ON CONFLICT DO NOTHING`,
      params,
    );
    inserted += rowCount;
  }
  return inserted;
}

async function main() {
  const foods = [...ifctFoods(), ...indbFoods()];
  const client = await pool.connect();
  let inserted;
  try {
    await client.query('BEGIN');
    inserted = await insertAll(client, foods);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows: samples } = await pool.query(
    `(SELECT name, source, calories, protein_g, carbs_g, fats_g, fiber_g, local_names, household_serving
        FROM foods WHERE source = 'ifct2017' ORDER BY name LIMIT 3)
     UNION ALL
     (SELECT name, source, calories, protein_g, carbs_g, fats_g, fiber_g, local_names, household_serving
        FROM foods WHERE source = 'indb' ORDER BY name LIMIT 2)`,
  );
  const { rows: totals } = await pool.query(
    'SELECT source, count(*)::int AS count FROM foods GROUP BY source ORDER BY source',
  );

  console.log(`Parsed ${foods.length} rows; inserted ${inserted} new foods (existing names kept).\n`);
  console.log('Sample imported rows:');
  samples.forEach((f, i) => {
    const local = f.local_names.length ? ` | local: ${f.local_names.slice(0, 2).join('; ')}` : '';
    const household = f.household_serving ? ` | ${f.household_serving}` : '';
    console.log(
      `${i + 1}. [${f.source}] ${f.name} — ${f.calories} kcal, P ${f.protein_g} C ${f.carbs_g} F ${f.fats_g} Fib ${f.fiber_g}${household}${local}`,
    );
  });
  console.log('\nFoods by source:');
  totals.forEach((t) => console.log(`  ${t.source}: ${t.count}`));
  console.log(`  total: ${totals.reduce((sum, t) => sum + t.count, 0)}`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seed failed:', err.message);
    pool.end().finally(() => process.exit(1));
  });
