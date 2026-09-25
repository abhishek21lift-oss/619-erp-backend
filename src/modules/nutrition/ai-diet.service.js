'use strict';
// Save a reviewed AI diet plan as a real diet: template + meals + assignment.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// The diet generator's output could only be previewed. Nothing on the backend
// materialised one, so a trainer who liked a generated plan had to retype it
// meal by meal in the diet builder — and production showed exactly that: 41
// generated workouts beside 5 diet assignments, 8 templates and one meal.
//
// ── What it writes, in one transaction ──────────────────────────────────────
//
//   diet_templates   one row, stamped with the studio, macros from the plan
//   meals            one row per meal, stamped with the studio; the foods go
//                    in the description because the library has no food table
//   diet_plan_meals  links, in the order the plan listed them
//   diet_assignments the template made active for the client
//
// All or nothing: a plan that half-saved would leave a template with some of
// its meals and no assignment, which is worse than no plan at all.
//
// ── Why the plan comes from the request ─────────────────────────────────────
//
// The workout save takes a generation id because workout generations are
// ledgered and screened server-side; diet generations are not. This route is
// trainer-only and writes nothing the trainer could not already write through
// POST /api/diet/templates and /assign — it only saves them the typing. So the
// body is treated as trainer-authored input and validated as strictly as that:
// shape, lengths and ranges, with anything out of range refused rather than
// clamped.

const { randomUUID } = require('crypto');
const pool = require('../../db/pool');

const MEAL_TYPES = ['breakfast', 'lunch', 'snacks', 'dinner', 'pre_workout', 'post_workout'];
const GOALS = ['weight_loss', 'muscle_gain', 'maintenance', 'keto', 'vegan', 'custom'];

class DietPlanError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function num(v, min, max, field) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new DietPlanError(`${field} must be a number between ${min} and ${max}`);
  }
  return n;
}

/** Nullable macro: absent stays unknown rather than becoming a 0 that reads as a fact. */
function macro(v, field) {
  if (v === null || v === undefined || v === '') return null;
  return num(v, 0, 1000, field);
}

/** The generator speaks in goals like "fat_loss"; the template column has a fixed set. */
function templateGoal(goal) {
  const g = String(goal || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (GOALS.includes(g)) return g;
  if (/fat|weight_?loss|cut|lean/.test(g)) return 'weight_loss';
  if (/muscle|gain|bulk|hypertrophy|strength/.test(g)) return 'muscle_gain';
  if (/maint|general|fitness|health/.test(g)) return 'maintenance';
  return 'custom';
}

/** A meal's type from its name first, then its time of day. */
function mealType(name, time) {
  const n = String(name || '').toLowerCase();
  if (/pre[\s-]?workout/.test(n)) return 'pre_workout';
  if (/post[\s-]?workout/.test(n)) return 'post_workout';
  if (/breakfast/.test(n)) return 'breakfast';
  if (/lunch/.test(n)) return 'lunch';
  if (/dinner|supper/.test(n)) return 'dinner';
  if (/snack/.test(n)) return 'snacks';
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(time || ''));
  if (m) {
    let h = Number(m[1]);
    if (m[3] && m[3].toLowerCase() === 'pm' && h < 12) h += 12;
    if (m[3] && m[3].toLowerCase() === 'am' && h === 12) h = 0;
    if (h < 11) return 'breakfast';
    if (h < 15) return 'lunch';
    if (h < 18) return 'snacks';
    return 'dinner';
  }
  return 'snacks';
}

/**
 * Validate a generated plan into exactly what will be written.
 * Throws DietPlanError (400) on anything the tables should not hold.
 */
function normalisePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new DietPlanError('plan is required');
  const name = str(plan.name, 120);
  if (!name) throw new DietPlanError('plan.name is required');
  if (!Array.isArray(plan.meals) || plan.meals.length === 0) {
    throw new DietPlanError('plan.meals must list at least one meal');
  }
  if (plan.meals.length > 12) throw new DietPlanError('plan.meals may list at most 12 meals');

  const meals = plan.meals.map((m, i) => {
    const mealName = str(m?.name, 120);
    if (!mealName) throw new DietPlanError(`meal ${i + 1} needs a name`);
    const foods = Array.isArray(m.foods) ? m.foods.slice(0, 30) : [];
    const foodLines = foods
      .map((f) => [str(f?.quantity, 60), str(f?.name, 120)].filter(Boolean).join(' '))
      .filter(Boolean);
    return {
      name: mealName,
      meal_type: mealType(mealName, m.time),
      calories: Math.round(num(m.calories, 0, 5000, `meal ${i + 1} calories`)),
      protein_g: macro(m.protein_g, `meal ${i + 1} protein_g`),
      carbs_g: macro(m.carbs_g, `meal ${i + 1} carbs_g`),
      fats_g: macro(m.fat_g, `meal ${i + 1} fat_g`),
      serving_size: str(m.time, 40) || null,
      description: foodLines.length ? foodLines.join('\n').slice(0, 2000) : null,
    };
  });

  const macros = plan.macros || {};
  return {
    name,
    description: [str(plan.description, 1000), str(plan.notes, 2000)].filter(Boolean).join('\n\n') || null,
    goal: templateGoal(plan.goal),
    daily_calories: Math.round(num(plan.total_calories, 500, 10000, 'plan.total_calories')),
    daily_protein_g: macro(macros.protein_g, 'plan.macros.protein_g'),
    daily_carbs_g: macro(macros.carbs_g, 'plan.macros.carbs_g'),
    daily_fats_g: macro(macros.fat_g, 'plan.macros.fat_g'),
    meals,
  };
}

/**
 * Write the plan and assign it. The caller has already checked that the
 * client belongs to `orgId`; every row written here is stamped with it.
 */
async function saveAiDietPlan({ plan, clientId, orgId, userId, trainerId }) {
  const p = normalisePlan(plan);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    const templateId = randomUUID();
    await db.query(
      `INSERT INTO diet_templates (id, name, description, goal,
         daily_calories, daily_protein_g, daily_carbs_g, daily_fats_g, created_by, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [templateId, p.name, p.description, p.goal, p.daily_calories,
        p.daily_protein_g, p.daily_carbs_g, p.daily_fats_g, userId, orgId],
    );

    for (const [i, m] of p.meals.entries()) {
      const mealId = randomUUID();
      await db.query(
        `INSERT INTO meals (id, name, description, meal_type, calories,
           protein_g, carbs_g, fats_g, serving_size, created_by, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [mealId, m.name, m.description, m.meal_type, m.calories,
          m.protein_g, m.carbs_g, m.fats_g, m.serving_size, userId, orgId],
      );
      await db.query(
        `INSERT INTO diet_plan_meals (id, diet_template_id, meal_id, day_of_week, sort_order)
         VALUES ($1,$2,$3,NULL,$4)`,
        [randomUUID(), templateId, mealId, i],
      );
    }

    const { rows } = await db.query(
      `INSERT INTO diet_assignments (id, diet_template_id, client_id, trainer_id,
         start_date, status, organization_id)
       VALUES ($1,$2,$3,$4,CURRENT_DATE,'active',$5)
       RETURNING *`,
      [randomUUID(), templateId, clientId, trainerId || null, orgId],
    );

    await db.query('COMMIT');
    return { template_id: templateId, name: p.name, meals: p.meals.length, assignment: rows[0] };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}

module.exports = { saveAiDietPlan, normalisePlan, mealType, templateGoal, DietPlanError, MEAL_TYPES };
