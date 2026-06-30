'use strict';
const { z }    = require('zod');
const pool     = require('../../../db/pool');
const { toolRegistry } = require('../registry/ToolRegistry');
const { routedChat } = require('../../ai/router');
const { logUsage }   = require('../../ai/usage');
const {
  buildWorkoutSystemPrompt,
  buildDietSystemPrompt,
} = require('../../ai/prompts/system');

// ─── Tool implementations ────────────────────────────────────────────────────

async function generateWorkout({ client_id, age, gender, weight_kg, height_cm, goal, experience_level, injuries = 'none', equipment = 'full gym', training_days = 4, duration_weeks = 8 }, context) {
  // Fetch client data if client_id provided
  let clientData = { age, gender, weight_kg, height_cm, goal, experience_level };
  if (client_id) {
    const { rows: [c] } = await pool.query(
      `SELECT dob, gender, (SELECT weight_kg FROM pt_assessments WHERE client_id=pt_clients.id ORDER BY created_at DESC LIMIT 1) AS weight_kg
       FROM pt_clients WHERE id=$1 AND deleted_at IS NULL`,
      [client_id]
    );
    if (c) {
      clientData.gender     = c.gender || gender;
      clientData.weight_kg  = c.weight_kg || weight_kg;
      if (c.dob) clientData.age = Math.floor((Date.now() - new Date(c.dob).getTime()) / 31557600000);
    }
  }

  const userPrompt = `Generate a ${duration_weeks}-week workout plan:
- Age: ${clientData.age}, Gender: ${clientData.gender}, Weight: ${clientData.weight_kg}kg, Height: ${height_cm}cm
- Goal: ${goal}, Experience: ${experience_level}
- Injuries: ${injuries}, Equipment: ${equipment}, Training days/week: ${training_days}`;

  const result = await routedChat({
    intent:      'workout',
    messages:    [
      { role: 'system', content: buildWorkoutSystemPrompt(context.userName || '') },
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0.6,
    max_tokens:  2048,
  });

  logUsage({ user_id: context.userId, model: result.model, intent_type: 'workout',
             tokens_prompt: result.usage?.prompt_tokens || 0,
             tokens_completion: result.usage?.completion_tokens || 0 }).catch(() => {});

  const plan = tryParseJSON(result.content);
  return { success: !!plan, plan: plan || result.content, model: result.model };
}

async function generateDiet({ client_id, age, gender, weight_kg, height_cm, activity_level, goal, dietary_preferences = 'none', allergies = 'none', budget = 'medium', meal_frequency = 4 }, context) {
  let clientData = { age, gender, weight_kg, height_cm, activity_level, goal };
  if (client_id) {
    const { rows: [c] } = await pool.query(
      `SELECT dob, gender, (SELECT weight_kg FROM pt_assessments WHERE client_id=pt_clients.id ORDER BY created_at DESC LIMIT 1) AS weight_kg
       FROM pt_clients WHERE id=$1 AND deleted_at IS NULL`,
      [client_id]
    );
    if (c) {
      clientData.gender    = c.gender || gender;
      clientData.weight_kg = c.weight_kg || weight_kg;
      if (c.dob) clientData.age = Math.floor((Date.now() - new Date(c.dob).getTime()) / 31557600000);
    }
  }

  const userPrompt = `Generate a personalised nutrition plan:
- Age: ${clientData.age}, Gender: ${clientData.gender}, Weight: ${clientData.weight_kg}kg, Height: ${height_cm}cm
- Activity: ${activity_level}, Goal: ${goal}, Preferences: ${dietary_preferences}
- Allergies: ${allergies}, Budget: ${budget}, Meals/day: ${meal_frequency}`;

  const result = await routedChat({
    intent:      'diet',
    messages:    [
      { role: 'system', content: buildDietSystemPrompt(context.userName || '') },
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0.5,
    max_tokens:  2500,
  });

  logUsage({ user_id: context.userId, model: result.model, intent_type: 'diet',
             tokens_prompt: result.usage?.prompt_tokens || 0,
             tokens_completion: result.usage?.completion_tokens || 0 }).catch(() => {});

  const plan = tryParseJSON(result.content);
  return { success: !!plan, plan: plan || result.content, model: result.model };
}

function tryParseJSON(text) {
  try { return JSON.parse(text); } catch { /* ignore */ }
  const m = text.match(/\{[\s\S]+\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

// ─── Registration ────────────────────────────────────────────────────────────

toolRegistry
  .register('aicoach.generateWorkout',
    generateWorkout,
    z.object({
      client_id:        z.union([z.string(), z.number()]).optional(),
      age:              z.number().int().min(10).max(100).optional(),
      gender:           z.string().optional(),
      weight_kg:        z.number().positive().optional(),
      height_cm:        z.number().positive().optional(),
      goal:             z.string().min(1),
      experience_level: z.string().min(1),
      injuries:         z.string().optional(),
      equipment:        z.string().optional(),
      training_days:    z.number().int().min(1).max(7).optional(),
      duration_weeks:   z.number().int().min(1).max(52).optional(),
    }),
    ['admin','manager','trainer'],
    false
  )
  .register('aicoach.generateDiet',
    generateDiet,
    z.object({
      client_id:            z.union([z.string(), z.number()]).optional(),
      age:                  z.number().int().min(10).max(100).optional(),
      gender:               z.string().optional(),
      weight_kg:            z.number().positive().optional(),
      height_cm:            z.number().positive().optional(),
      activity_level:       z.string().min(1),
      goal:                 z.string().min(1),
      dietary_preferences:  z.string().optional(),
      allergies:            z.string().optional(),
      budget:               z.string().optional(),
      meal_frequency:       z.number().int().min(1).max(8).optional(),
    }),
    ['admin','manager','trainer'],
    false
  );

module.exports = { generateWorkout, generateDiet };
