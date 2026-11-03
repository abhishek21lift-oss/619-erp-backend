'use strict';

// Can this org program with this exercise?
//
// An exercise id is client-supplied on every builder write, so it is checked
// at the trust boundary rather than trusted into a foreign key. A row is
// visible when it is a shared built-in or belongs to the caller's studio, and
// when it has not been archived or soft-deleted. The check is deliberately the
// same one the exercise library itself lists by: a programme must not be able
// to reference something the trainer cannot see.

const pool = require('../db/pool');

async function findVisibleExercise(exerciseId, organizationId, db = pool) {
  if (!exerciseId) return null;
  const { rows } = await db.query(
    `SELECT id, name, movement_pattern AS "movementPattern"
       FROM exercises
      WHERE id = $1 AND deleted_at IS NULL AND archived_at IS NULL
        AND (organization_id IS NULL OR organization_id = $2)`,
    [exerciseId, organizationId],
  );
  return rows[0] || null;
}

module.exports = { findVisibleExercise };
