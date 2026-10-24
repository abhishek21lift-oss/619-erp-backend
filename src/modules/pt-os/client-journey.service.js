'use strict';
// The intake journey, in the K11 onboarding order:
//
//   Welcome & Gym Tour → PT Enrolment → Informed Consent → PAR-Q →
//   Client Interview → Goals → Fitness Assessment → Program Design
//
// Each step's state is read here, live and org-scoped, from the record that
// step produces — never from what a screen last showed. The profile's journey
// card and every "next step" button read this, so they cannot disagree with
// the gates that enforce the order (lib/screeningGate).
//
// The interview is optional (studio decision, Phase 2, 2026-10-02): it shows
// as a step with its status and never blocks enrolment. Registration is the
// prerequisite for the journey, not one of its steps.

const pool = require('../../db/pool');
const { screeningSummary } = require('../../lib/screeningGate');
const { hasPtTermSql } = require('../../lib/ptTerm');

const INTERVIEW_FIELDS = Object.freeze([
  'training_history', 'pain_and_injuries', 'lifestyle', 'motivation',
  'availability', 'preferences', 'notes',
  'lifestyle_occupation', 'lifestyle_sitting_hours', 'lifestyle_screen_time',
  'lifestyle_sleep_hours', 'lifestyle_meal_regularity', 'lifestyle_smoking',
  'lifestyle_alcohol', 'lifestyle_training_days',
]);
const FIELD_MAX = Object.freeze({ availability: 1000, preferences: 1000, lifestyle_occupation: 50, lifestyle_screen_time: 10, lifestyle_meal_regularity: 20, lifestyle_smoking: 20, lifestyle_alcohol: 20 });

class InterviewInputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** The fields of an interview body, trimmed and bounded. Structured lifestyle fields accept numbers/enums; text fields stay text. Unknown keys are ignored. */
function interviewFields(body = {}) {
  const out = {};
  const STRUCTURED = new Set(['lifestyle_occupation','lifestyle_sitting_hours','lifestyle_screen_time','lifestyle_sleep_hours','lifestyle_meal_regularity','lifestyle_smoking','lifestyle_alcohol','lifestyle_training_days']);
  for (const key of INTERVIEW_FIELDS) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === '') { out[key] = null; continue; }
    if (STRUCTURED.has(key)) {
      out[key] = (body[key] === null || body[key] === '') ? null : body[key];
      continue;
    }
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

/** A completed interview has to say something (text or structured answers count, text only is sufficient). */
function assertCompletable(row) {
  const lifestyleKeys = ['lifestyle_occupation','lifestyle_sitting_hours','lifestyle_screen_time','lifestyle_sleep_hours','lifestyle_meal_regularity','lifestyle_smoking','lifestyle_alcohol','lifestyle_training_days'];
  const hasText = INTERVIEW_FIELDS.some((k) => row[k] && String(row[k]).trim() && !lifestyleKeys.includes(k));
  const hasLifestyle = lifestyleKeys.some((k) => row[k] != null && (typeof row[k] === 'number' ? true : String(row[k]).trim() !== ''));
  if (!hasText && !hasLifestyle) throw new InterviewInputError('Write down at least one answer before completing the interview.');
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

/** Record the K11 welcome and gym tour. Idempotent: the first timestamp stays. */
async function markWelcomeTour(orgId, clientId) {
  const { rows } = await pool.query(
    `UPDATE pt_clients
        SET welcome_tour_completed_at = COALESCE(welcome_tour_completed_at, NOW()),
            updated_at = NOW()
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
      RETURNING id, welcome_tour_completed_at`,
    [clientId, orgId],
  );
  return rows[0] || null;
}

const STEP_ORDER = Object.freeze([
  'welcome_tour', 'enrolment', 'consent', 'parq', 'interview', 'goals', 'assessment', 'program_design',
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
    `SELECT c.id, c.status, c.welcome_tour_completed_at,
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

  // A plan can only be built for a client who may train. A provisional
  // enrolment (pending until screening completes) is done as a step but not
  // yet trainable.
  const canTrain = c.status === 'active' && !c.ended;
  const programDesignState = c.has_active_plan ? 'done'
    : enrolmentState === 'done' && canTrain ? 'todo' : 'blocked';
  const programDesignDetail = enrolmentState !== 'done'
    ? 'Enrol the client in PT before assigning a plan.'
    : 'Activate the client (complete screening) before assigning a plan.';

  const steps = [
    {
      key: 'welcome_tour',
      state: c.welcome_tour_completed_at || c.has_pt_term ? 'done' : 'todo',
    },
    {
      key: 'enrolment', state: enrolmentState,
      ...(enrolmentState === 'blocked' && !c.has_pt_term
        ? { detail: 'Complete the Informed Consent and PAR-Q before enrolling.' } : {}),
    },
    { key: 'consent', state: consentState, ...(consentState === 'blocked' ? { detail: screening.block?.message } : {}) },
    { key: 'parq', state: parqState, ...(parqState === 'blocked' ? { detail: screening.block?.message } : {}) },
    {
      key: 'interview', optional: true,
      state: c.interview_status === 'completed' ? 'done' : c.interview_status === 'draft' ? 'in_progress' : 'todo',
    },
    { key: 'goals', state: c.has_goal ? 'done' : 'todo' },
    { key: 'assessment', state: c.has_assessment ? 'done' : 'todo' },
    {
      key: 'program_design', state: programDesignState,
      ...(programDesignState === 'blocked' ? { detail: programDesignDetail } : {}),
    },
  ];
  const next = steps.find((s) => s.state !== 'done')?.key ?? null;
  return { steps, next, screening };
}

module.exports = {
  listInterviews, createInterview, updateInterview, journey, markWelcomeTour,
  InterviewInputError, INTERVIEW_FIELDS, STEP_ORDER,
};
