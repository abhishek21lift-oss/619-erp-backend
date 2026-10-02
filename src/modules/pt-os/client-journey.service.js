'use strict';
// The intake journey, and its one missing step: the Client Interview.
//
//   Registration → Informed Consent → PAR-Q → Client Interview →
//   Fitness Assessment → Goals → PT Enrolment → Workout Plan
//
// Each step's state is read here, live and org-scoped, from the record that
// step produces — never from what a screen last showed. The profile's journey
// card and every "next step" button read this, so they cannot disagree with
// the gates that enforce the order (lib/screeningGate).
//
// The interview is optional (studio decision, Phase 2, 2026-10-02): it shows
// as a step with its status and never blocks enrolment.

const pool = require('../../db/pool');
const { screeningSummary } = require('../../lib/screeningGate');
const { hasPtTermSql } = require('../../lib/ptTerm');

const INTERVIEW_FIELDS = Object.freeze([
  'training_history', 'pain_and_injuries', 'lifestyle', 'motivation',
  'availability', 'preferences', 'notes',
]);
const FIELD_MAX = Object.freeze({ availability: 1000, preferences: 1000 });

class InterviewInputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** The fields of an interview body, trimmed and bounded. Unknown keys are ignored. */
function interviewFields(body = {}) {
  const out = {};
  for (const key of INTERVIEW_FIELDS) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === '') { out[key] = null; continue; }
    if (typeof body[key] !== 'string') throw new InterviewInputError(`${key} must be text.`);
    const v = body[key].trim();
    if (v.length > (FIELD_MAX[key] || 2000)) throw new InterviewInputError(`${key} is too long.`);
    out[key] = v || null;
  }
  return out;
}

function statusOf(body) {
  if (body.status === undefined) return undefined;
  if (body.status !== 'draft' && body.status !== 'completed') {
    throw new InterviewInputError('status must be draft or completed.');
  }
  return body.status;
}

/** A completed interview has to say something. */
function assertCompletable(row) {
  if (!INTERVIEW_FIELDS.some((k) => row[k] && String(row[k]).trim())) {
    throw new InterviewInputError('Write down at least one answer before completing the interview.');
  }
}

async function clientExists(orgId, clientId) {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM pt_clients WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
    [clientId, orgId],
  );
  return rowCount > 0;
}

async function listInterviews(orgId, clientId) {
  if (!await clientExists(orgId, clientId)) return null;
  const { rows } = await pool.query(
    `SELECT * FROM pt_client_interviews
      WHERE client_id = $1 AND organization_id = $2
      ORDER BY created_at DESC`,
    [clientId, orgId],
  );
  return rows;
}

async function createInterview(orgId, clientId, userId, body) {
  const fields = interviewFields(body);
  const status = statusOf(body) || 'draft';
  if (status === 'completed') assertCompletable(fields);
  if (!await clientExists(orgId, clientId)) return null;
  const cols = Object.keys(fields);
  const { rows } = await pool.query(
    `INSERT INTO pt_client_interviews
       (organization_id, client_id, status, interviewed_by, completed_at${cols.map((c) => `, ${c}`).join('')})
     VALUES ($1, $2, $3, $4, ${status === 'completed' ? 'NOW()' : 'NULL'}${cols.map((_, i) => `, $${i + 5}`).join('')})
     RETURNING *`,
    [orgId, clientId, status, userId || null, ...cols.map((c) => fields[c])],
  );
  return rows[0];
}

/**
 * Edit an interview. Org-scoped: another studio's id is null, like a missing
 * one. Completing stamps completed_at once; moving a completed interview back
 * to draft is refused — a new interview is started instead.
 */
async function updateInterview(orgId, interviewId, userId, body) {
  const fields = interviewFields(body);
  const status = statusOf(body);
  const { rows: [existing] } = await pool.query(
    `SELECT i.* FROM pt_client_interviews i
       JOIN pt_clients c ON c.id = i.client_id AND c.organization_id = i.organization_id AND c.deleted_at IS NULL
      WHERE i.id = $1 AND i.organization_id = $2`,
    [interviewId, orgId],
  );
  if (!existing) return null;
  if (existing.status === 'completed' && status === 'draft') {
    throw new InterviewInputError('A completed interview cannot be reopened. Start a new interview instead.', 409);
  }
  const merged = { ...existing, ...fields };
  const completing = status === 'completed' && existing.status !== 'completed';
  if (completing || (existing.status === 'completed' && Object.keys(fields).length)) assertCompletable(merged);

  const sets = [];
  const params = [interviewId, orgId];
  for (const [k, v] of Object.entries(fields)) { params.push(v); sets.push(`${k} = $${params.length}`); }
  if (completing) {
    sets.push("status = 'completed'", 'completed_at = NOW()');
    params.push(userId || null);
    sets.push(`interviewed_by = COALESCE(interviewed_by, $${params.length})`);
  }
  if (!sets.length) return existing;
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(
    `UPDATE pt_client_interviews SET ${sets.join(', ')}
      WHERE id = $1 AND organization_id = $2 RETURNING *`,
    params,
  );
  return rows[0];
}

// ── The journey ─────────────────────────────────────────────────────────────

const STEP_ORDER = Object.freeze([
  'registration', 'consent', 'parq', 'interview', 'assessment', 'goals', 'enrolment', 'workout_plan',
]);

/**
 * Where this client is in the intake journey.
 *
 * Each step is { key, state, detail?, optional? } with state one of
 *   done · in_progress · todo · blocked · renew
 * and `next` is the first step that is not done (the interview included, as
 * the next thing to do, though it never blocks a later step).
 *
 * @returns {Promise<null | { steps: object[], next: string|null, screening: object }>}
 */
async function journey(orgId, clientId) {
  const { rows: [c] } = await pool.query(
    `SELECT c.id, c.status,
            ${hasPtTermSql('c')} AS has_pt_term,
            (c.pt_end_date IS NOT NULL AND c.pt_end_date < CURRENT_DATE) AS ended,
            (SELECT status FROM pt_client_interviews i
              WHERE i.client_id = c.id AND i.organization_id = c.organization_id
              ORDER BY (i.status = 'completed') DESC, i.created_at DESC LIMIT 1) AS interview_status,
            EXISTS (SELECT 1 FROM pt_assessments a
                     WHERE a.client_id = c.id AND a.organization_id = c.organization_id) AS has_assessment,
            EXISTS (SELECT 1 FROM pt_goals g
                     WHERE g.client_id = c.id AND g.organization_id = c.organization_id) AS has_goal,
            EXISTS (SELECT 1 FROM workout_assignments wa
                     WHERE wa.client_id = c.id AND wa.organization_id = c.organization_id
                       AND wa.status = 'active') AS has_active_plan
       FROM pt_clients c
      WHERE c.id = $1 AND c.organization_id = $2 AND c.deleted_at IS NULL`,
    [clientId, orgId],
  );
  if (!c) return null;
  const screening = await screeningSummary(clientId);

  const consentState = {
    completed: 'done', in_progress: 'in_progress', none: 'todo', revoked: 'blocked', expired: 'blocked',
  }[screening.consent.status] || 'todo';

  let parqState;
  if (screening.block?.code === 'PARQ_BLOCKED') parqState = 'blocked';
  else if (screening.parq.status === 'none') parqState = 'todo';
  else if (screening.parq.status === 'in_progress' || !screening.parq.complete) parqState = 'in_progress';
  else parqState = 'done';

  let enrolmentState;
  if (c.has_pt_term && c.status === 'active' && !c.ended) enrolmentState = 'done';
  else if (c.has_pt_term && (c.status === 'expired' || c.ended)) enrolmentState = 'renew';
  else if (c.has_pt_term && c.status === 'frozen') enrolmentState = 'blocked';
  else enrolmentState = screening.complete ? 'todo' : 'blocked';

  const steps = [
    { key: 'registration', state: 'done' },
    { key: 'consent', state: consentState, ...(consentState === 'blocked' ? { detail: screening.block?.message } : {}) },
    { key: 'parq', state: parqState, ...(parqState === 'blocked' ? { detail: screening.block?.message } : {}) },
    {
      key: 'interview', optional: true,
      state: c.interview_status === 'completed' ? 'done' : c.interview_status === 'draft' ? 'in_progress' : 'todo',
    },
    { key: 'assessment', state: c.has_assessment ? 'done' : 'todo' },
    { key: 'goals', state: c.has_goal ? 'done' : 'todo' },
    {
      key: 'enrolment', state: enrolmentState,
      ...(enrolmentState === 'blocked' && !c.has_pt_term
        ? { detail: 'Complete the Informed Consent and PAR-Q before enrolling.' } : {}),
    },
    {
      key: 'workout_plan',
      state: c.has_active_plan ? 'done' : enrolmentState === 'done' ? 'todo' : 'blocked',
      ...(!c.has_active_plan && enrolmentState !== 'done' ? { detail: 'Enrol the client in PT before assigning a plan.' } : {}),
    },
  ];
  const next = steps.find((s) => s.state !== 'done')?.key ?? null;
  return { steps, next, screening };
}

module.exports = {
  listInterviews, createInterview, updateInterview, journey,
  InterviewInputError, INTERVIEW_FIELDS, STEP_ORDER,
};
