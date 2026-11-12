'use strict';
// The generation ledger: what the diet engine proposed, before anyone
// accepted it. Writes are best-effort at the call site — a successful
// generation must not fail because its bookkeeping did.

const { randomUUID } = require('crypto');
const pool = require('../../db/pool');

const json = (v) => (v == null ? null : JSON.stringify(v));

async function recordDietGeneration({
  orgId, clientId, createdBy, requestId = null, model = null, revised = false,
  plan, inputs = null, dataQuality = null, calculation = null, schedule = null,
  validation = null, grounding = null, engineVersion = null, promptVersion = null,
}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO ai_diet_generations
       (id, organization_id, client_id, created_by, request_id, model, revised,
        proposed_plan, inputs, data_quality, calculation, schedule, validation,
        grounding, engine_version, prompt_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,
             $12::jsonb,$13::jsonb,$14::jsonb,$15,$16)`,
    [id, orgId || null, clientId, createdBy || null, requestId, model, revised === true,
      json(plan), json(inputs), json(dataQuality), json(calculation), json(schedule),
      json(validation), json(grounding), engineVersion, promptVersion],
  );
  return id;
}

async function readDietGeneration(generationId, orgId) {
  const { rows } = await pool.query(
    `SELECT id, organization_id, client_id, proposed_plan, inputs, calculation,
            schedule, validation, grounding, engine_version, prompt_version,
            accepted_template_id, created_at
       FROM ai_diet_generations
      WHERE id = $1 AND organization_id = $2`,
    [generationId, orgId || null],
  );
  return rows[0] ?? null;
}

async function markDietGenerationAccepted(generationId, templateId, assignmentId, orgId) {
  const { rowCount } = await pool.query(
    `UPDATE ai_diet_generations
        SET accepted_template_id = $2, accepted_assignment_id = $3, accepted_at = NOW()
      WHERE id = $1 AND organization_id = $4 AND accepted_template_id IS NULL`,
    [generationId, templateId, assignmentId || null, orgId || null],
  );
  return rowCount;
}

module.exports = { recordDietGeneration, readDietGeneration, markDietGenerationAccepted };
