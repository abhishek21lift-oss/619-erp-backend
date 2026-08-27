'use strict';
/**
 * One active trainer per studio, and one owner.
 *
 * The database enforces the trainer half through the partial unique index
 * `trainers_one_active_per_org` (migration 184), which refuses to be skipped —
 * if it cannot be built the migration aborts the deploy. So the constraint is
 * always there, and these helpers are not what enforces the rule.
 *
 * What they do is turn the refusal into something a studio owner can act on. A
 * unique violation reaching the client is a 500 naming a constraint, which says
 * nothing about what they did or what to do next; a 409 naming the trainer who
 * already holds the slot says both. They are the courtesy, not the guarantee —
 * which is why they check-then-insert without a transaction and that is fine:
 * losing the race means the index rejects the second write anyway.
 *
 * The owner half has no database constraint on purpose. A partial unique index
 * on admins would fail to build wherever two already exist, and demoting one
 * silently changes a real person's access — so the rule lives here alone, and
 * migration 184 reports the studios that need a human.
 *
 * ── Two response shapes, deliberately ──────────────────────────────────────
 *
 * `src/routes/*` answer `{ error: 'message' }` and `src/modules/*` answer
 * `{ error: { code, message } }`. Both guards are needed in both trees, so
 * rather than impose one shape on a file that does not use it, each is offered
 * in the shape its neighbours already use. Callers pick; the message and the
 * code are identical either way.
 */

const { tenantScope } = require('./tenant-db');

/**
 * The studio's existing active trainer, or null.
 *
 * Returns null when the caller has no single org — a platform super admin
 * operating platform-wide — because "the studio's trainer" is not a question
 * with an answer there, and blocking on it would break the operator console.
 *
 * `status`, not `is_active`: trainers carry a status column with
 * CHECK (status IN ('active','inactive')) and no is_active. Archiving a trainer
 * means setting status='inactive', which is exactly what frees the slot.
 */
async function activeTrainerOf(pool, req) {
  const { orgId } = tenantScope(req);
  if (!orgId) return null;
  const { rows } = await pool.query(
    `SELECT id, name, email FROM trainers
      WHERE organization_id = $1 AND status = 'active' AND deleted_at IS NULL
      ORDER BY created_at, id LIMIT 1`,
    [orgId]
  );
  return rows[0] || null;
}

/**
 * The studio's existing active admin, or null.
 *
 * `is_active = true AND deleted_at IS NULL` matches how the LAST_ADMIN guard
 * counts admins (super-admin/organizations.js:327-331). Using a looser
 * definition here would let a deactivated account block a studio from ever
 * getting a working owner.
 *
 * Takes an explicit orgId because the platform console creates users *into* a
 * studio named in the URL, which is not the caller's own org.
 */
async function activeOwnerOf(pool, req, orgIdOverride) {
  const orgId = orgIdOverride || (req ? tenantScope(req).orgId : null);
  if (!orgId) return null;
  const { rows } = await pool.query(
    `SELECT id, name, email FROM users
      WHERE organization_id = $1 AND role = 'admin'
        AND is_active = true AND deleted_at IS NULL
      ORDER BY created_at, id LIMIT 1`,
    [orgId]
  );
  return rows[0] || null;
}

// Both messages name the account that already holds the slot: the next thing
// the caller wants is to edit it rather than add another, and without the name
// they have to go and look it up.
const trainerLimitMessage = (t) =>
  `${t.name} is already this studio's trainer. A studio has one trainer — edit them instead of adding another.`;

const ownerExistsMessage = (u) =>
  `${u.name || u.email} already owns this studio. A studio has one owner.`;

/** `{ error: 'message', code, trainer }` — the src/routes/* shape. */
const trainerLimitFlat = (t) => ({
  error: trainerLimitMessage(t), code: 'TRAINER_LIMIT', trainer: { id: t.id, name: t.name },
});

/** `{ error: { code, message, trainer } }` — the src/modules/* shape. */
const trainerLimitNested = (t) => ({
  error: { code: 'TRAINER_LIMIT', message: trainerLimitMessage(t), trainer: { id: t.id, name: t.name } },
});

const ownerExistsFlat = (u) => ({
  error: ownerExistsMessage(u), code: 'OWNER_EXISTS', owner: { id: u.id, email: u.email },
});

const ownerExistsNested = (u) => ({
  error: { code: 'OWNER_EXISTS', message: ownerExistsMessage(u), owner: { id: u.id, email: u.email } },
});

module.exports = {
  activeTrainerOf, activeOwnerOf,
  trainerLimitMessage, ownerExistsMessage,
  trainerLimitFlat, trainerLimitNested,
  ownerExistsFlat, ownerExistsNested,
};
