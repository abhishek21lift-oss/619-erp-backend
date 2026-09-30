'use strict';
// Which trainer a member's screens name — one rule, in one place.
//
// The member app shows its trainer in three places: the profile (dashboard,
// account and membership card), the coach page, and the message thread. Each
// used to resolve the trainer with its own query, and the three disagreed:
//
//   - the profile took the NAME from `trainers` and the PHOTO from `users`,
//     and read the legacy `trainers.specialization` (empty for 7 of 8 studios)
//     instead of the specialisations the trainer fills in on My Profile;
//   - the coach page took everything from `users`, ignoring is_active;
//   - the message thread took `trainers.name`, with no deleted check on it.
//
// My Profile writes `users.name`, not `trainers.name`, so the first rename
// would have shown a member two different names for one coach.
//
// The rule now: the live, active trainer ACCOUNT linked to the client's
// assigned trainer, else the studio's own trainer account (a studio has
// exactly one — migration 208). Name, photo and specialisations all come from
// that account and its My Profile row, because that is what the trainer edits.

/**
 * A LATERAL subquery yielding one row (id, name, trainer_id) for the client
 * aliased `c`. Use as: LEFT JOIN LATERAL (${trainerOfClient('c')}) tu ON TRUE
 */
function trainerOfClient(c) {
  return `
    SELECT su.id, su.name, su.trainer_id
      FROM users su
     WHERE su.organization_id = ${c}.organization_id AND su.role = 'trainer'
       AND su.deleted_at IS NULL AND su.is_active = TRUE
     ORDER BY (${c}.trainer_id IS NOT NULL AND su.trainer_id = ${c}.trainer_id) DESC, su.created_at
     LIMIT 1`;
}

/**
 * The one-line specialisation a member sees under the trainer's name: the
 * first two specialisations from My Profile, else their designation, else the
 * legacy trainers.specialization. `up` is user_profiles, `tt` is trainers.
 */
const TRAINER_SPECIALISATION_SQL = `
  COALESCE(
    (SELECT NULLIF(string_agg(x, ' · '), '')
       FROM (SELECT jsonb_array_elements_text(
                      CASE WHEN jsonb_typeof(up.specialisations) = 'array' THEN up.specialisations ELSE '[]'::jsonb END) AS x
               LIMIT 2) s),
    NULLIF(up.designation, ''),
    NULLIF(tt.specialization, ''))`;

module.exports = { trainerOfClient, TRAINER_SPECIALISATION_SQL };

/**
 * Carry a trainer's new name to the two places that still store a copy.
 *
 * My Profile updates users.name. `trainers.name` and the denormalised
 * `pt_clients.trainer_name` are read by older screens (and were read by the
 * member app), and nothing updated them — so a trainer who renamed themselves
 * went on appearing under the old name there. Only rows that differ are
 * written. No-op for an account with no trainer link (a member, the operator).
 */
async function syncTrainerName(db, userId, name) {
  const { rows } = await db.query(
    `SELECT u.trainer_id, u.organization_id FROM users u
      WHERE u.id = $1 AND u.role = 'trainer' AND u.trainer_id IS NOT NULL`,
    [userId],
  );
  const link = rows[0];
  if (!link) return;
  await db.query(
    `UPDATE trainers SET name = $3, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2 AND name IS DISTINCT FROM $3`,
    [link.trainer_id, link.organization_id, name],
  );
  await db.query(
    `UPDATE pt_clients SET trainer_name = $3
      WHERE trainer_id = $1 AND organization_id = $2 AND trainer_name IS DISTINCT FROM $3`,
    [link.trainer_id, link.organization_id, name],
  );
}

module.exports.syncTrainerName = syncTrainerName;
