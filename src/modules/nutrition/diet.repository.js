'use strict';
// Diet writes that need a transaction or a partial update.
//
// routes/diet.js keeps the HTTP concerns (auth, tenant guards, status codes)
// and calls these. The two behaviours that must not live in an adapter:
//
//   · createTemplate writes the template and its meal links in ONE
//     transaction, after proving every meal id belongs to this studio (or is
//     shared library content).
//   · upsertTracker updates only the fields the caller sent. The old route
//     wrote `parseInt(...) || 0` for all six columns, so tapping "+ Glass"
//     wiped the day's calories and macros back to zero.

const { randomUUID } = require('crypto');
const pool = require('../../db/pool');
const { parseStrict } = require('../../lib/zodNumbers');

const GOALS = ['weight_loss', 'muscle_gain', 'maintenance', 'keto', 'vegan', 'custom'];
// request field → template column
const MACRO_FIELDS = {
  daily_protein_g: 'protein_g',
  daily_carbs_g: 'carbs_g',
  daily_fats_g: 'fats_g',
};
const ASSIGNMENT_STATUSES = ['completed', 'cancelled', 'paused'];

class DietInputError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function textOrNull(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}

/** Nullable macro: absent/blank stays unknown, never becomes a 0 that reads as a fact. */
function macroOrNull(raw, field) {
  const parsed = parseStrict(raw);
  if (!parsed.ok) {
    if (parsed.reason === 'absent') return null;
    throw new DietInputError(`${field} must be a number`);
  }
  if (parsed.value < 0 || parsed.value > 1000) {
    throw new DietInputError(`${field} must be a number between 0 and 1000`);
  }
  return parsed.value;
}

/** Calories cannot be null in the table, so absent keeps the historical 2000 default. */
function caloriesOr(raw) {
  const parsed = parseStrict(raw);
  if (!parsed.ok) {
    if (parsed.reason === 'absent') return 2000;
    throw new DietInputError('daily_calories must be a number');
  }
  if (!Number.isInteger(parsed.value) || parsed.value < 0 || parsed.value > 20000) {
    throw new DietInputError('daily_calories must be a whole number between 0 and 20000');
  }
  return parsed.value;
}

function normaliseTemplate(input) {
  if (!input || typeof input !== 'object') throw new DietInputError('template is required');
  const rawName = input.name === null || input.name === undefined ? '' : String(input.name).trim();
  if (!rawName) throw new DietInputError('Template name required');
  if (rawName.length > 120) throw new DietInputError('Template name must be 120 characters or fewer');
  const name = rawName;

  const goal = input.goal === null || input.goal === undefined || input.goal === ''
    ? 'maintenance'
    : String(input.goal);
  if (!GOALS.includes(goal)) {
    throw new DietInputError(`goal must be one of ${GOALS.join(', ')}`);
  }

  const macros = {};
  for (const [requestField, column] of Object.entries(MACRO_FIELDS)) {
    macros[column] = macroOrNull(input[requestField], requestField);
  }

  const rawMeals = input.meals === null || input.meals === undefined ? [] : input.meals;
  if (!Array.isArray(rawMeals)) throw new DietInputError('meals must be an array');
  if (rawMeals.length > 50) throw new DietInputError('a template may list at most 50 meals');

  const meals = rawMeals.map((m, i) => {
    const mealId = textOrNull(m?.meal_id, 100);
    if (!mealId) throw new DietInputError(`meal ${i + 1} needs a meal_id`);

    let day = null;
    if (m?.day_of_week !== null && m?.day_of_week !== undefined && String(m.day_of_week).trim() !== '') {
      const n = Number(m.day_of_week);
      if (!Number.isInteger(n) || n < 1 || n > 7) {
        throw new DietInputError(`meal ${i + 1} day_of_week must be a whole number between 1 and 7`);
      }
      day = n;
    }

    const sortRaw = m?.sort_order;
    const sort = sortRaw === null || sortRaw === undefined || String(sortRaw).trim() === ''
      ? i
      : Number(sortRaw);
    if (!Number.isInteger(sort) || sort < 0 || sort > 10000) {
      throw new DietInputError(`meal ${i + 1} sort_order must be a whole number of 0 or more`);
    }

    return { meal_id: mealId, day_of_week: day, sort_order: sort };
  });

  return {
    name,
    description: textOrNull(input.description, 2000),
    goal,
    daily_calories: caloriesOr(input.daily_calories),
    ...macros,
    meals,
  };
}

/**
 * Create a template and its meal links atomically.
 * Every meal id must be visible to `orgId`: shared (organization_id IS NULL)
 * or this studio's own. A foreign id refuses the whole write.
 */
async function createTemplate({ input, orgId, userId }) {
  const t = normaliseTemplate(input);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    if (t.meals.length) {
      const ids = [...new Set(t.meals.map((m) => m.meal_id))];
      const { rows } = await db.query(
        `SELECT id FROM meals
          WHERE id = ANY($1::text[]) AND is_active = true
            AND (organization_id IS NULL OR organization_id = $2)`,
        [ids, orgId],
      );
      if (rows.length !== ids.length) {
        throw new DietInputError('meal not found or not available');
      }
    }

    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO diet_templates (id, name, description, goal,
         daily_calories, daily_protein_g, daily_carbs_g, daily_fats_g, created_by, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, t.name, t.description, t.goal, t.daily_calories,
        t.protein_g, t.carbs_g, t.fats_g, userId, orgId],
    );

    for (const m of t.meals) {
      await db.query(
        `INSERT INTO diet_plan_meals (id, diet_template_id, meal_id, day_of_week, sort_order)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), id, m.meal_id, m.day_of_week, m.sort_order],
      );
    }

    await db.query('COMMIT');
    return rows[0];
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}

const TRACKER_COLUMNS = {
  calories_consumed: { integer: true, max: 20000 },
  protein_g: { max: 2000 },
  carbs_g: { max: 2000 },
  fats_g: { max: 2000 },
  water_glasses: { integer: true, max: 100 },
};

/** Only the keys the caller actually sent; a supplied blank means "clear". */
function normaliseTracker(input) {
  if (!input || typeof input !== 'object') throw new DietInputError('tracker values are required');
  const values = {};

  for (const [field, spec] of Object.entries(TRACKER_COLUMNS)) {
    if (!(field in input)) continue;
    const raw = input[field];
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      values[field] = null;
      continue;
    }
    const parsed = parseStrict(raw);
    if (!parsed.ok) throw new DietInputError(`${field} must be a number`);
    if (parsed.value < 0 || parsed.value > spec.max
      || (spec.integer && !Number.isInteger(parsed.value))) {
      throw new DietInputError(
        `${field} must be ${spec.integer ? 'a whole number' : 'a number'} between 0 and ${spec.max}`,
      );
    }
    values[field] = parsed.value;
  }

  if ('notes' in input) values.notes = textOrNull(input.notes, 2000);
  return values;
}

/**
 * Partial upsert. Absent fields are untouched on an existing row and NULL on a
 * new one; a supplied null/blank clears the column.
 */
async function upsertTracker({ clientId, orgId, logDate, input }) {
  const values = normaliseTracker(input);
  const columns = Object.keys(values);

  const insertColumns = ['id', 'client_id', 'log_date', 'organization_id', ...columns];
  const params = [randomUUID(), clientId, logDate, orgId, ...columns.map((c) => values[c])];
  const placeholders = insertColumns.map((_, i) => `$${i + 1}`);

  const updates = columns.map((c, i) => `${c} = $${5 + i}`);
  updates.push('organization_id = COALESCE(nutrition_logs.organization_id, EXCLUDED.organization_id)');
  updates.push('updated_at = NOW()');

  const { rows } = await pool.query(
    `INSERT INTO nutrition_logs (${insertColumns.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (client_id, log_date) DO UPDATE SET ${updates.join(', ')}
     RETURNING *`,
    params,
  );
  return rows[0];
}

async function updateAssignmentStatus({ id, orgId, status }) {
  if (!ASSIGNMENT_STATUSES.includes(status)) {
    throw new DietInputError(`status must be one of ${ASSIGNMENT_STATUSES.join(', ')}`);
  }
  const { rows } = await pool.query(
    `UPDATE diet_assignments
        SET status = $1,
            end_date = CASE WHEN $1 IN ('completed','cancelled') THEN CURRENT_DATE ELSE end_date END,
            updated_at = NOW()
      WHERE id = $2 AND organization_id = $3
      RETURNING *`,
    [status, id, orgId],
  );
  return rows[0] || null;
}

module.exports = {
  createTemplate, upsertTracker, updateAssignmentStatus,
  normaliseTemplate, normaliseTracker, DietInputError,
  GOALS, ASSIGNMENT_STATUSES,
};
