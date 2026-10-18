'use strict';

// Data access for the workout generator.
//
// The SQL lives here, not in the route adapter — the layering convention test
// (architecture.layering.convention.test.js) is absolute for files absent
// from its debt register, and a new module has no business adding to it.
//
// Both reads are tenant-scoped by an explicit organization id. NULL org binds
// no rows, which is the fail-closed behaviour the rest of the tenant layer
// shares; the caller never passes an org it was not authenticated for.

const pool = require('../../db/pool');

/** The client row the generator needs, or null when it is not this org's. */
async function findClientForOrg(clientId, organizationId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.goal, c.workout_experience_level, c.injuries, c.organization_id
       FROM pt_clients c
      WHERE c.id = $1 AND c.deleted_at IS NULL AND c.organization_id = $2`,
    [clientId, organizationId],
  );
  return rows[0] || null;
}

/**
 * The exercise pool: shared built-ins (organization_id IS NULL) plus the org's
 * custom exercises. Archived and soft-deleted rows are never candidates.
 */
async function listLibraryPool(organizationId) {
  const { rows } = await pool.query(
    `SELECT e.id, e.name, e.mechanic, e.movement_pattern AS "movementPattern",
            e.difficulty, e.category_id,
            m.name AS "primaryMuscle",
            q.name AS equipment,
            cat.name AS category
       FROM exercises e
       LEFT JOIN muscles m           ON m.id = e.primary_muscle_id
       LEFT JOIN equipment_types q   ON q.id = e.equipment_id
       LEFT JOIN exercise_categories cat ON cat.id = e.category_id
      WHERE e.deleted_at IS NULL
        AND e.archived_at IS NULL
        AND (e.organization_id IS NULL OR e.organization_id = $1)`,
    [organizationId],
  );
  return rows;
}

module.exports = { findClientForOrg, listLibraryPool };
