'use strict';

// Which trainer profiles ARE the calling user.
//
// Extracted from pt-os.routes.js so the voice surface can apply the same
// narrowing without a second copy of it. The logic is unchanged; the comment
// below is the original and is the reason a single id is not enough.
//
const pool = require('../db/pool');
const { tenantScope } = require('./tenant-db');

// Every trainer profile that IS the caller, as a list of pt_sessions.trainer_id
// values to match on.
//
// Two things make a single id wrong here.
//
// First, `users.trainer_id` is only ever populated by the studio-approval path
// (super-admin/registrations.js, super-admin/organizations.js) — those create a
// `trainers` row and link it in the same transaction. An account created any
// other way (the /auth/register route leaves it null unless a trainer_id is
// passed, and every pre-approval-flow studio predates it) has no link at all,
// even when that person is the studio's only trainer and has a full diary.
// Keying solely off the column reported "not linked" to the studio owner and
// told them to ask an admin — which they are.
//
// Second, `pt_sessions.trainer_id` has had NO foreign key since migration
// 018 dropped pt_sessions_trainer_id_fkey, and the Book Session picker is fed
// by GET /trainers, a UNION of `trainers` and `pt_trainers`. So a booked
// session's trainer_id can be an id from EITHER table, and the same human
// routinely exists in both. Matching one id misses the other's sessions.
//
// Hence: the explicit link, plus an email match in both tables, all within the
// caller's own organisation. Email is the join the two trainer tables already
// share — 018 seeded pt_trainers FROM trainers carrying it across.
//
// The org filter mirrors GET /trainers exactly, including excluding NULL
// organization_id rather than treating it as shared: an unattributable trainer
// matched into someone's schedule is the same leak that route was fixed for.
// This is defence in depth only — the session query below is independently
// org-scoped, which is the boundary that actually holds.
async function resolveMyTrainerIds(req) {
  const ids = new Set();
  if (req.user.trainer_id) ids.add(req.user.trainer_id);

  const email = String(req.user.email || '').trim().toLowerCase();
  if (email) {
    const scope = tenantScope(req);
    const params = [email];
    let orgFilter = '';
    if (scope.applyFilter) {
      params.push(scope.orgId);
      orgFilter = `AND organization_id = $${params.length}`;
    }
    const { rows } = await pool.query(`
      SELECT id FROM trainers
       WHERE deleted_at IS NULL AND LOWER(email) = $1 ${orgFilter}
      UNION
      SELECT id FROM pt_trainers
       WHERE deleted_at IS NULL AND LOWER(email) = $1 ${orgFilter}
    `, params);
    for (const r of rows) ids.add(r.id);
  }

  return [...ids];
}

module.exports = { resolveMyTrainerIds };
