'use strict';
// Data access for the training domain.
//
// ── Why this file exists ────────────────────────────────────────────────────
//
// The target architecture is route → service → repository → database, and
// training.service.js already says so in its own header: "The routes below
// this are thin on purpose — they validate, authorise, and call in here."
// That was true for the session lifecycle it owns and had never been true for
// anything else: training.routes.js still issued 27 SQL literals of its own,
// so the adapter was also the data layer for programmes, templates and
// assignments.
//
// This file is where that SQL belongs. It is separate from
// training.service.js rather than appended to it because the two do different
// jobs, and that file is explicit about its own: everything that "spans more
// than one table, or that has to be all-or-nothing, lives in this file inside
// a transaction". Programme and template CRUD is neither. Folding plain reads
// and single-row writes into a file about transactional session lifecycle
// would blur the one boundary that module already gets right.
//
// ── Why these functions take `req` ──────────────────────────────────────────
//
// A repository coupled to HTTP is not the textbook shape, and it is the shape
// this module already uses: every exported function in training.service.js
// takes `req` first (createSession(req, body), startSession(req, sessionId)).
// The reason is authorisation — authz.orgWhere() and authz.trainerWhere()
// derive their SQL fragments and bind parameters from the caller's identity,
// and the tenant boundary must be applied in the same statement that reads the
// rows, not bolted on by whoever remembers to.
//
// Passing `req` keeps that single-statement guarantee. Threading an
// "identity" object through instead would be tidier and would be a second
// convention in one module; consistency wins here, and the day authz stops
// needing `req`, both files change together.
//
// ── Scope ───────────────────────────────────────────────────────────────────
//
// Programmes, phases and weeks only, so far. Templates, prescriptions,
// assignments and the session read paths are still in the adapter and are the
// next entries to move; the layering budget in
// architecture.layering.convention.test.js is what tracks that, and it only
// ever ratchets down.

const pool = require('../../db/pool');
const authz = require('./authz');
const { orgIdOf } = require('../../lib/tenant-db');

/**
 * Build a SET clause from the fields a caller is allowed to patch.
 *
 * Lives here rather than in the adapter because it writes SQL, which is the
 * whole point of the layer. The adapter still imports it for the clusters
 * that have not moved yet — templates, assignments, sessions — and that
 * import disappears with the last of them.
 *
 * `startAt` is the first bind index, so a caller that has already bound $1
 * (usually the row id) passes 2.
 */
function patchFrom(body, allowed, startAt = 1) {
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    values.push(body[key]);
    sets.push(`${key} = $${startAt + values.length - 1}`);
  }
  return { sets, values };
}

const PROGRAM_PATCH_COLS = [
  'name', 'description', 'goal', 'program_type', 'duration_weeks',
  'status', 'start_date', 'end_date', 'notes', 'client_id',
];

/**
 * Programmes visible to this caller, newest first.
 *
 * A trainer who is not admin/manager sees programmes for their own clients
 * plus the studio's unassigned templates (client_id IS NULL) — carried over
 * exactly, because narrowing it would hide a studio's shared programmes from
 * the trainers who use them.
 */
async function listPrograms(req, { clientId, status } = {}) {
  const params = [];
  const org = authz.orgWhere(req, params, 'p.organization_id');
  const filters = [];
  if (clientId) { params.push(clientId); filters.push(`p.client_id = $${params.length}`); }
  if (status) { params.push(status); filters.push(`p.status = $${params.length}`); }

  const trainer = authz.seesAllClients(req) || !req.user.trainer_id
    ? ''
    : (params.push(req.user.trainer_id),
      ` AND (p.client_id IS NULL OR EXISTS (
           SELECT 1 FROM pt_clients c WHERE c.id = p.client_id AND c.trainer_id = $${params.length}))`);

  const { rows } = await pool.query(
    `SELECT p.* FROM training_programs p
      WHERE p.deleted_at IS NULL${org}${trainer}
        ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY p.created_at DESC LIMIT 200`,
    params
  );
  return rows;
}

/** The phases and weeks hanging off one programme, in display order. */
async function loadProgramParts(programId) {
  const [phases, weeks] = await Promise.all([
    pool.query('SELECT * FROM training_program_phases WHERE program_id = $1 ORDER BY phase_order', [programId]),
    pool.query('SELECT * FROM training_program_weeks  WHERE program_id = $1 ORDER BY week_number', [programId]),
  ]);
  return { phases: phases.rows, weeks: weeks.rows };
}

async function createProgram(req, b) {
  const { rows } = await pool.query(
    `INSERT INTO training_programs
       (organization_id, client_id, created_by, name, description, goal, program_type,
        duration_weeks, start_date, end_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'GENERAL_FITNESS'),$8,$9,$10,$11) RETURNING *`,
    [orgIdOf(req), b.client_id ?? null, req.user.id, b.name, b.description ?? null,
      b.goal ?? null, b.program_type ?? null, b.duration_weeks ?? null,
      b.start_date ?? null, b.end_date ?? null, b.notes ?? null]
  );
  return rows[0];
}

/**
 * Patch a programme.
 *
 * Returns null when the body named no patchable field, so the adapter can
 * keep answering that case exactly as it did rather than issuing an UPDATE
 * with an empty SET clause.
 */
async function updateProgram(programId, body) {
  const { sets, values } = patchFrom(body, PROGRAM_PATCH_COLS, 2);
  if (!sets.length) return null;
  const { rows } = await pool.query(
    `UPDATE training_programs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [programId, ...values]
  );
  return rows[0];
}

/**
 * Soft delete. Sessions logged against this programme stay readable, which is
 * the whole reason historical rows are never hard-deleted.
 */
async function softDeleteProgram(programId) {
  await pool.query('UPDATE training_programs SET deleted_at = NOW() WHERE id = $1', [programId]);
}

async function createPhase(programId, b) {
  const { rows } = await pool.query(
    `INSERT INTO training_program_phases (program_id, name, phase_order, week_start, week_end, goal, notes)
     VALUES ($1,$2,COALESCE($3,1),$4,$5,$6,$7) RETURNING *`,
    [programId, b.name, b.phase_order ?? null, b.week_start, b.week_end, b.goal ?? null, b.notes ?? null]
  );
  return rows[0];
}

/** Upsert, keyed on (program_id, week_number) — re-posting a week edits it. */
async function upsertWeek(programId, b) {
  const { rows } = await pool.query(
    `INSERT INTO training_program_weeks (program_id, phase_id, week_number, name, notes, is_deload)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,false))
     ON CONFLICT (program_id, week_number) DO UPDATE
        SET phase_id = EXCLUDED.phase_id, name = EXCLUDED.name,
            notes = EXCLUDED.notes, is_deload = EXCLUDED.is_deload, updated_at = NOW()
     RETURNING *`,
    [programId, b.phase_id ?? null, b.week_number, b.name ?? null, b.notes ?? null, b.is_deload ?? null]
  );
  return rows[0];
}

module.exports = {
  patchFrom,
  listPrograms,
  loadProgramParts,
  createProgram,
  updateProgram,
  softDeleteProgram,
  createPhase,
  upsertWeek,
};
