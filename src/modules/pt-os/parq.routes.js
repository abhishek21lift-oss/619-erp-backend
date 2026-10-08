// src/modules/pt-os/parq.routes.js
// PAR-Q + Health Screening + Medical Clearance + Digital Consent module.
// Mounted at /api/pt-os, so final paths are /api/pt-os/parq/...
//
// Conventions follow src/modules/progress/progress.routes.js: zod validation
// with a local numOpt() helper, a server-side "compute analysis on write"
// function re-run on both POST and PATCH so derived columns never drift
// from raw inputs, and a shared wrap() for async error handling.
const router = require('express').Router();
const multer = require('multer');
const pool = require('../../db/pool');
const { detectFileType, DOCUMENTS } = require('../../lib/fileSignatures');
const logger = require('../../lib/logger');
const { auth, requireTrainer } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const { logActivity } = require('../../lib/activityLog');
const { generateConsentPdf } = require('../../lib/parqPdf');
const { saveFile } = require('../../lib/fileStorage');
const { tenantScope, orgIdOf } = require('../../lib/tenant-db');
const { clientInOrg } = require('../../lib/orgGuard');
const { computeParqAnalysis } = require('./parq-scoring');
const { clearanceApprovalProblem } = require('./parq-clearance');
const { validClearanceSql, PARQ_QUESTION_COUNT } = require('../../lib/screeningGate');
const { invalidFileType } = require('../../middleware/errorHandler');
const { signatureDataUrl, describeAgent } = require('../../lib/signing');

// The studio trainer only. server.js mounts this router behind requireTrainer
// too; declaring it here as well means the guard travels with the router and
// cannot be lost if the mount is edited or the router is mounted again.
router.use(auth, requireTrainer);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const numOpt = () => z.coerce.number().optional().nullable();

// ─── Analysis helpers (shared by POST + PATCH so derived columns never drift) ───

// PAR-Q risk rule — see ./parq-scoring.js.

function calcBmi(weightKg, heightCm) {
  const w = Number(weightKg);
  const h = Number(heightCm);
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return null;
  const heightM = h / 100;
  return Math.round((w / (heightM * heightM)) * 10) / 10;
}

// A form leaves draft only with every question answered. The risk rule
// counts "yes" answers, so a blank question scores exactly like a "no": a
// "submitted" form with nothing answered was stored as low risk and cleared
// the client to train. Only the wizard used to enforce this.
function unansweredQuestions(answers) {
  const answered = new Set(
    (Array.isArray(answers) ? answers : [])
      .filter((a) => a && (a.answer === 'yes' || a.answer === 'no'))
      .map((a) => Number(a.question_id))
  );
  const missing = [];
  for (let q = 1; q <= PARQ_QUESTION_COUNT; q++) if (!answered.has(q)) missing.push(q);
  return missing;
}

function incompleteResponse(res, missing) {
  return res.status(400).json({
    error: {
      code: 'PARQ_INCOMPLETE',
      message: `Answer every PAR-Q question before submitting (unanswered: ${missing.join(', ')}).`,
      unanswered: missing,
    },
  });
}

const answersChanged = (before, after) => {
  const key = (list) => JSON.stringify(
    (Array.isArray(list) ? list : [])
      .map((a) => [Number(a.question_id), a.answer || ''])
      .sort((x, y) => x[0] - y[0])
  );
  return key(before) !== key(after);
};

// Authoritative gate-status recompute — callable from both the form routes
// (POST/PATCH /forms) and the medical-clearance routes, since approving a
// clearance later must flip a previously-blocked form to cleared.
async function recomputeGateStatus(pool, formId) {
  const { rows: formRows } = await pool.query(
    'SELECT risk_level FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL', [formId]
  );
  const form = formRows[0];
  if (!form) return null;

  let gateStatus;
  if (form.risk_level === 'high') {
    // Same rule the screening gate applies at read time: the latest
    // decision on the form, approved and unexpired.
    const { rows: clearanceRows } = await pool.query(
      `SELECT ${validClearanceSql('$1')} AS ok`, [formId]
    );
    gateStatus = clearanceRows[0]?.ok ? 'cleared' : 'blocked';
  } else {
    gateStatus = 'cleared';
  }

  const { rows } = await pool.query(
    `UPDATE pt_parq_forms SET workout_gate_status = $1, updated_at = NOW()
      WHERE id = $2 RETURNING workout_gate_status, risk_level`,
    [gateStatus, formId]
  );
  return rows[0];
}

// Delete + reinsert is the simplest correct approach for this small child
// collection (a handful of rows per form). Safe to call with an empty/no
// prior rows too, so POST reuses it instead of duplicating the INSERT loop.
async function replaceFamilyHistory(tx, formId, list) {
  await tx.query('DELETE FROM pt_family_medical_history WHERE parq_form_id = $1', [formId]);
  for (const fh of (list || [])) {
    await tx.query(
      `INSERT INTO pt_family_medical_history (
         parq_form_id, relation, heart_disease, diabetes, stroke, hypertension, cancer,
         hyperlipidemia, kidney_disease, sudden_death, age_of_onset, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        formId, fh.relation,
        Boolean(fh.heart_disease), Boolean(fh.diabetes), Boolean(fh.stroke), Boolean(fh.hypertension),
        Boolean(fh.cancer), Boolean(fh.hyperlipidemia), Boolean(fh.kidney_disease), Boolean(fh.sudden_death),
        fh.age_of_onset ?? null, fh.notes || null,
      ]
    );
  }
}

// ─── Schemas ────────────────────────────────────────────────

const parqAnswerSchema = z.object({
  // One of the ten fixed questions. Anything else used to be stored as-is and
  // quietly ignored by the risk rule — or double-counted as a duplicate.
  question_id: z.coerce.number().int().min(1).max(PARQ_QUESTION_COUNT),
  // Draft-friendly: the form is created as a draft on step 1, before the user
  // reaches the PAR-Q step, so an answer may still be blank. '' / null means
  // "not yet answered". computeParqAnalysis() ignores anything that isn't
  // 'yes', and the client enforces all-answered before submit.
  answer: z.enum(['yes', 'no']).or(z.literal('')).optional().nullable(),
  explanation: z.string().max(1000).optional().nullable(),
  diagnosis_date: z.string().optional().nullable(),
  treatment: z.string().max(500).optional().nullable(),
  doctor_name: z.string().max(255).optional().nullable(),
  hospital: z.string().max(255).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

const familyHistorySchema = z.object({
  relation: z.enum(['father', 'mother', 'brother', 'sister', 'grandparent']),
  heart_disease: z.boolean().optional(),
  diabetes: z.boolean().optional(),
  stroke: z.boolean().optional(),
  hypertension: z.boolean().optional(),
  cancer: z.boolean().optional(),
  hyperlipidemia: z.boolean().optional(),
  kidney_disease: z.boolean().optional(),
  sudden_death: z.boolean().optional(),
  age_of_onset: numOpt(),
  notes: z.string().max(1000).optional().nullable(),
});

// The screening gate reads the LATEST form by assessment_date, so a
// future-dated form would sit on top of every real one — a low-risk form dated
// next year hides today's high-risk answers. One day of slack absorbs a
// device whose clock or timezone is ahead of the server's.
const notFutureDate = () => z.string().optional().nullable().refine(
  (v) => !v || Number.isNaN(Date.parse(v)) || Date.parse(v) <= Date.now() + 86400000,
  { message: 'assessment_date cannot be in the future' }
);

const parqFormFields = {
    assessment_date: notFutureDate(),

    // Step 1: Client snapshot
    full_name: z.string().min(1).max(255),
    gender: z.string().max(20).optional().nullable(),
    dob: z.string().optional().nullable(),
    mobile: z.string().max(20).optional().nullable(),
    email: z.string().email().max(255).optional().nullable(),
    emergency_contact: z.string().max(255).optional().nullable(),
    emergency_phone: z.string().max(20).optional().nullable(),
    blood_group: z.string().max(10).optional().nullable(),
    height_cm: numOpt(), weight_kg: numOpt(), bmi: numOpt(),
    trainer_name: z.string().max(255).optional().nullable(),

    // Step 2: Current Health (heterogeneous toggle+expand fields)
    current_health: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 3: Past Medical History
    past_history: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 4: Family Medical History
    family_history: z.array(familyHistorySchema).optional().nullable(),

    // Step 5: PAR-Q — up to the 10 fixed questions; a draft created on step 1
    // may carry blank/unanswered entries (see parqAnswerSchema).
    parq_answers: z.array(parqAnswerSchema).max(PARQ_QUESTION_COUNT)
      .refine((list) => new Set(list.map((a) => a.question_id)).size === list.length,
        { message: 'Each PAR-Q question may be answered once' })
      .optional(),

    // Step 7: Trainer Notes
    trainer_notes: z.record(z.string(), z.unknown()).optional().nullable(),

    status: z.enum(['draft', 'submitted', 'reviewed']).optional(),
};

const parqFormCreateSchema = {
  body: z.object({
    client_id: z.string(),
    ...parqFormFields,
    parq_answers: parqFormFields.parq_answers.default([]),
  }),
};

// No .default() may sit in parqFormFields: zod 4 applies defaults inside
// .partial(), so a PATCH that omitted parq_answers would arrive as [] and the
// recompute would silently re-score the client as low risk.
//
// PATCH used to take any body at all: parq_answers of any shape or length and
// any status string went straight into the row and into the risk recompute.
// Same field rules as create, every field optional, client_id not movable.
const parqFormUpdateSchema = {
  body: z.object(parqFormFields).partial(),
};

const clearanceCreateSchema = {
  body: z.object({
    doctor_name: z.string().max(255).optional().nullable(),
    hospital: z.string().max(255).optional().nullable(),
    clearance_date: z.string().optional().nullable(),
    certificate_url: z.string().max(1000).optional().nullable(),
    doctor_contact: z.string().max(50).optional().nullable(),
    expiry_date: z.string().optional().nullable(),
    approval_status: z.enum(['approved', 'rejected', 'pending']).optional(),
  }),
};

const clearanceUpdateSchema = {
  body: clearanceCreateSchema.body.partial(),
};

// What the PAR-Q signature attests: that these answers are true. Risk,
// voluntary participation, emergency care and data use are the Informed
// Consent's to collect, and were being signed for twice (the other six keys
// may still appear on older records, and still print on their PDFs).
const CONSENT_KEYS = ['info_true'];

const consentCreateSchema = {
  body: z.object({
    consent_checkboxes: z.record(z.string(), z.boolean()),
    client_signature: signatureDataUrl,
    trainer_signature: signatureDataUrl.optional().nullable(),
    location: z.string().max(500).optional().nullable(),
  }),
};

// ─── PAR-Q Forms ────────────────────────────────────────────

// GET /parq/forms?client_id=
router.get('/parq/forms', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = ['deleted_at IS NULL'];
  const params = [];
  const scope = tenantScope(req);
  params.push(scope.orgId); where.push(`organization_id = $${params.length}`);
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM pt_parq_forms WHERE ${where.join(' AND ')} ORDER BY assessment_date DESC`, params
  );
  res.json({ data: rows });
}));

// GET /parq/forms/:id — form + family history + clearance + consent + documents.
// Parallel queries rather than one giant JOIN (child collections have very
// different cardinalities/shapes, so a JOIN would just require de-duplicating
// the parent row in application code anyway).
//
// Clearance and consent are returned SINGULAR — `medical_clearance` and
// `consent`, not the underlying row arrays. That is the shape the client's
// ParqFormDetail contract declares, and the edit screen reads
// `row.medical_clearance?.id` to decide update-vs-create. Emitting the arrays
// here (as this route used to) left both fields undefined on the client: the
// clearance and consent sections silently rendered blank for forms that had
// them, and every re-save took the create path and wrote a duplicate
// pt_medical_clearances row. Both queries order by created_at DESC, so row 0
// is the current record; a form only ever has one live clearance/consent.
router.get('/parq/forms/:id', auth, wrap(async (req, res) => {
  const { id } = req.params;
  const scope = tenantScope(req);
  const formGuard = ' AND organization_id = $2';
  const formParams = [id, scope.orgId];
  const [formRes, familyRes, clearanceRes, consentRes, docsRes] = await Promise.all([
    pool.query(`SELECT * FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${formGuard}`, formParams),
    pool.query('SELECT * FROM pt_family_medical_history WHERE parq_form_id = $1 ORDER BY created_at', [id]),
    pool.query('SELECT * FROM pt_medical_clearances WHERE parq_form_id = $1 ORDER BY created_at DESC', [id]),
    pool.query('SELECT * FROM pt_consent_records WHERE parq_form_id = $1 ORDER BY created_at DESC', [id]),
    pool.query('SELECT * FROM pt_parq_documents WHERE parq_form_id = $1 ORDER BY created_at DESC', [id]),
  ]);
  const form = formRes.rows[0];
  if (!form) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  res.json({
    data: {
      ...form,
      family_history: familyRes.rows,
      medical_clearance: clearanceRes.rows[0] ?? null,
      consent: consentRes.rows[0] ?? null,
      documents: docsRes.rows,
    },
  });
}));

// GET /parq/forms/:id/gate-status — lightweight pre-check for the frontend
// before showing the workout Assign button.
router.get('/parq/forms/:id/gate-status', auth, wrap(async (req, res) => {
  const scope = tenantScope(req);
  const gsGuard = ' AND organization_id = $2';
  const { rows } = await pool.query(
    `SELECT workout_gate_status, risk_level FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${gsGuard}`,
    [req.params.id, scope.orgId]
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ data: rows[0] });
}));

// POST /parq/forms
router.post('/parq/forms', auth, requireTrainer, validate(parqFormCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  // The screening gate decides whether this client may train from their
  // latest form, so a form written against another studio's client would be
  // a cross-tenant write into a medical-safety control.
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const status = b.status || 'submitted';
  if (status !== 'draft') {
    const missing = unansweredQuestions(b.parq_answers);
    if (missing.length) return incompleteResponse(res, missing);
  }
  const analysis = computeParqAnalysis(b.parq_answers);
  const gateStatus = analysis.riskLevel === 'high' ? 'blocked' : 'cleared';
  const bmi = b.bmi ?? calcBmi(b.weight_kg, b.height_cm);

  const tx = await pool.connect();
  let formId;
  try {
    await tx.query('BEGIN');
    // assessment_number is "this client's Nth PAR-Q". Serialise per client so
    // two submits at once cannot both read the same max, and number from the
    // live forms: COUNT(*)+1 counted soft-deleted forms and repeated a number
    // once a middle form was deleted.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`parq:${b.client_id}`]);
    const { rows } = await tx.query(
      `INSERT INTO pt_parq_forms (
         client_id, assessment_date, assessment_number,
         full_name, gender, dob, mobile, email, emergency_contact, emergency_phone, blood_group,
         height_cm, weight_kg, bmi, trainer_name,
         current_health, past_history,
         parq_answers, parq_yes_count,
         risk_level, risk_message,
         trainer_notes,
         status, workout_gate_status,
         created_by, organization_id
       ) VALUES (
         $1, COALESCE($2, CURRENT_DATE), (SELECT COALESCE(MAX(assessment_number), 0) + 1 FROM pt_parq_forms WHERE client_id = $1 AND deleted_at IS NULL),
         $3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,
         $15::jsonb,$16::jsonb,
         $17::jsonb,$18,
         $19,$20,
         $21::jsonb,
         $22,$23,
         $24,$25
       ) RETURNING id`,
      [
        b.client_id, b.assessment_date || null,
        b.full_name, b.gender || null, b.dob || null, b.mobile || null, b.email || null,
        b.emergency_contact || null, b.emergency_phone || null, b.blood_group || null,
        b.height_cm ?? null, b.weight_kg ?? null, bmi ?? null, b.trainer_name || null,
        b.current_health ? JSON.stringify(b.current_health) : null,
        b.past_history ? JSON.stringify(b.past_history) : null,
        JSON.stringify(b.parq_answers), analysis.yesCount,
        analysis.riskLevel, analysis.riskMessage,
        b.trainer_notes ? JSON.stringify(b.trainer_notes) : null,
        status, gateStatus,
        req.user.id, orgIdOf(req),
      ]
    );
    formId = rows[0].id;

    await replaceFamilyHistory(tx, formId, b.family_history);

    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }

  // Authoritative recompute after commit (accounts for any pre-existing
  // approved medical clearance — unlikely on first submit, but keeps this
  // the single source of truth for gate status everywhere).
  await recomputeGateStatus(pool, formId);

  await logActivity(req, status === 'draft' ? 'parq.draft' : 'parq.submit', 'pt_parq_forms', formId, {
    client_id: b.client_id, risk_level: analysis.riskLevel, yes_count: analysis.yesCount,
  });

  const { rows: finalRows } = await pool.query('SELECT * FROM pt_parq_forms WHERE id = $1', [formId]);
  res.status(201).json({ data: finalRows[0] });
}));

// PATCH /parq/forms/:id
router.patch('/parq/forms/:id', auth, requireTrainer, validate(parqFormUpdateSchema), wrap(async (req, res) => {
  const { id } = req.params;
  const b = req.body;

  const allowedScalar = [
    'assessment_date', 'full_name', 'gender', 'dob', 'mobile', 'email',
    'emergency_contact', 'emergency_phone', 'blood_group',
    'height_cm', 'weight_kg', 'bmi', 'trainer_name',
    'current_health', 'past_history', 'parq_answers', 'trainer_notes', 'status',
  ];
  const jsonFields = new Set(['current_health', 'past_history', 'parq_answers', 'trainer_notes']);

  const tx = await pool.connect();
  let formId;
  let audit = null;
  try {
    await tx.query('BEGIN');
    const scope = tenantScope(req);
    const upGuard = ' AND organization_id = $2';
    const { rows: existingRows } = await tx.query(
      `SELECT * FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${upGuard} FOR UPDATE`,
      [id, scope.orgId]
    );
    const existing = existingRows[0];
    if (!existing) {
      await tx.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }

    const mergedAnswers = b.parq_answers !== undefined ? b.parq_answers : existing.parq_answers;
    const analysis = computeParqAnalysis(mergedAnswers);
    const gateStatus = analysis.riskLevel === 'high' ? 'blocked' : 'cleared';

    const priorStatus = existing.status || 'submitted';
    // A screened form never goes back to draft: the gate skips drafts, so
    // that one PATCH would hide a high-risk result and leave the client
    // looking merely unscreened.
    if (priorStatus !== 'draft' && b.status === 'draft') {
      await tx.query('ROLLBACK');
      return res.status(409).json({ error: { code: 'PARQ_ALREADY_SUBMITTED', message: 'A submitted PAR-Q cannot be returned to draft.' } });
    }
    const changedAnswers = b.parq_answers !== undefined && answersChanged(existing.parq_answers, mergedAnswers);
    let nextStatus = b.status !== undefined ? b.status : priorStatus;
    // A review covers the answers that were reviewed. Changed answers need
    // a fresh review, so the form drops back to submitted — even when the
    // edit screen echoes the stored 'reviewed' status back.
    if (priorStatus === 'reviewed' && nextStatus === 'reviewed' && changedAnswers) nextStatus = 'submitted';
    if (nextStatus !== 'draft') {
      const missing = unansweredQuestions(mergedAnswers);
      if (missing.length) {
        await tx.query('ROLLBACK');
        return incompleteResponse(res, missing);
      }
    }
    if (nextStatus !== priorStatus) b.status = nextStatus;

    let bmi;
    if (b.bmi !== undefined) {
      bmi = b.bmi;
    } else if (b.height_cm !== undefined || b.weight_kg !== undefined) {
      const mergedHeight = b.height_cm !== undefined ? b.height_cm : existing.height_cm;
      const mergedWeight = b.weight_kg !== undefined ? b.weight_kg : existing.weight_kg;
      bmi = calcBmi(mergedWeight, mergedHeight);
    } else {
      bmi = existing.bmi;
    }

    const sets = [];
    const params = [id];
    for (const key of allowedScalar) {
      if (b[key] !== undefined) {
        const isJson = jsonFields.has(key) && b[key] !== null && b[key] !== undefined;
        params.push(isJson ? JSON.stringify(b[key]) : b[key]);
        sets.push(`${key} = $${params.length}${isJson ? '::jsonb' : ''}`);
      }
    }

    // Derived columns are always refreshed — even a family-history-only
    // edit still needs risk fields recomputed from the (possibly merged)
    // parq_answers so they never drift.
    for (const [col, val] of Object.entries({
      parq_yes_count: analysis.yesCount, risk_level: analysis.riskLevel, risk_message: analysis.riskMessage,
      bmi, workout_gate_status: gateStatus,
    })) {
      params.push(val); sets.push(`${col} = $${params.length}`);
    }

    sets.push('updated_at = NOW()');
    await tx.query(`UPDATE pt_parq_forms SET ${sets.join(', ')} WHERE id = $1`, params);

    if (b.family_history !== undefined) {
      await replaceFamilyHistory(tx, id, b.family_history);
    }

    await tx.query('COMMIT');
    formId = id;

    // Edits to a screened form change who may train, so every one is on the
    // audit trail — a "yes" quietly turned into a "no" used to leave no trace.
    if (priorStatus === 'draft' && nextStatus !== 'draft') {
      audit = ['parq.submit', { client_id: existing.client_id, risk_level: analysis.riskLevel, yes_count: analysis.yesCount }];
    } else if (priorStatus !== 'draft') {
      audit = [nextStatus === 'reviewed' && priorStatus !== 'reviewed' ? 'parq.review' : 'parq.update', {
        client_id: existing.client_id,
        answers_changed: changedAnswers,
        risk_level_before: existing.risk_level, risk_level_after: analysis.riskLevel,
        status_before: priorStatus, status_after: nextStatus,
      }];
    }
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }

  // Authoritative recompute — approving a clearance earlier may already
  // have cleared the gate; this re-confirms against the clearance table
  // rather than trusting the tentative value written above.
  await recomputeGateStatus(pool, formId);
  if (audit) await logActivity(req, audit[0], 'pt_parq_forms', formId, audit[1]);

  const { rows } = await pool.query('SELECT * FROM pt_parq_forms WHERE id = $1', [formId]);
  res.json({ data: rows[0] });
}));

// ─── Medical Clearance ──────────────────────────────────────

// POST /parq/forms/:formId/clearance
router.post('/parq/forms/:formId/clearance', auth, requireTrainer, validate(clearanceCreateSchema), wrap(async (req, res) => {
  const { formId } = req.params;
  const scope = tenantScope(req);
  const clGuard = ' AND organization_id = $2';
  const { rows: formRows } = await pool.query(
    `SELECT client_id, organization_id FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${clGuard}`,
    [formId, scope.orgId]
  );
  const form = formRows[0];
  if (!form) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const b = req.body;
  const problem = await clearanceApprovalProblem(formId, b);
  if (problem) return res.status(400).json({ error: { code: 'CLEARANCE_EVIDENCE_REQUIRED', message: problem } });

  const { rows } = await pool.query(
    `INSERT INTO pt_medical_clearances (
       parq_form_id, client_id, doctor_name, hospital, clearance_date,
       certificate_url, doctor_contact, expiry_date, approval_status, organization_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      formId, form.client_id, b.doctor_name || null, b.hospital || null, b.clearance_date || null,
      b.certificate_url || null, b.doctor_contact || null, b.expiry_date || null, b.approval_status || 'pending',
      form.organization_id,
    ]
  );

  const gate = await recomputeGateStatus(pool, formId);
  res.status(201).json({ data: { ...rows[0], gate } });
}));

// PATCH /parq/clearance/:id
router.patch('/parq/clearance/:id', auth, requireTrainer, validate(clearanceUpdateSchema), wrap(async (req, res) => {
  const allowed = ['doctor_name', 'hospital', 'clearance_date', 'certificate_url', 'doctor_contact', 'expiry_date', 'approval_status'];

  const scope = tenantScope(req);
  const mcGuard = ' AND organization_id = $2';
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_medical_clearances WHERE id = $1${mcGuard}`,
    [req.params.id, scope.orgId]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  // Judged on the record as it will stand after this edit, so neither
  // approving a bare record nor stripping the evidence from an approved one
  // gets through.
  const merged = { ...existing };
  for (const key of allowed) if (req.body[key] !== undefined) merged[key] = req.body[key];
  const problem = await clearanceApprovalProblem(existing.parq_form_id, merged);
  if (problem) return res.status(400).json({ error: { code: 'CLEARANCE_EVIDENCE_REQUIRED', message: problem } });

  const sets = [];
  const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { params.push(req.body[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const statusChanged = req.body.approval_status !== undefined && req.body.approval_status !== existing.approval_status;
  if (statusChanged) {
    params.push(req.user.id); sets.push(`reviewed_by = $${params.length}`);
    sets.push('reviewed_at = NOW()');
  }
  sets.push('updated_at = NOW()');

  const { rows } = await pool.query(`UPDATE pt_medical_clearances SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  const updated = rows[0];

  const gate = await recomputeGateStatus(pool, updated.parq_form_id);

  if (statusChanged) {
    const action = updated.approval_status === 'approved' ? 'parq.clearance.approve'
      : updated.approval_status === 'rejected' ? 'parq.clearance.reject'
      : 'parq.clearance.update';
    await logActivity(req, action, 'pt_medical_clearances', updated.id, {
      formId: updated.parq_form_id, approval_status: updated.approval_status,
    });
  }

  res.json({ data: { ...updated, gate } });
}));

// ─── Digital Consent ────────────────────────────────────────

// POST /parq/forms/:formId/consent
//
// The trainer signs this, not the member. Consent is taken in person on the
// studio's device during onboarding, so requiring the trainer is both
// accurate to how the form is used AND safer than opening it to any
// authenticated user — which would let an unrelated member account sign a
// consent record for a client they have no association with.
router.post('/parq/forms/:formId/consent', auth, requireTrainer, validate(consentCreateSchema), wrap(async (req, res) => {
  const { formId } = req.params;
  const scope = tenantScope(req);
  const coGuard = ' AND organization_id = $2';
  const { rows: formRows } = await pool.query(
    `SELECT client_id, organization_id FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${coGuard}`,
    [formId, scope.orgId]
  );
  const form = formRows[0];
  if (!form) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const b = req.body;
  const checkboxes = b.consent_checkboxes || {};
  const allAgreed = CONSENT_KEYS.every((k) => checkboxes[k] === true);
  if (!allAgreed) {
    return res.status(400).json({ error: { code: 'CONSENT_REQUIRED', message: 'The client must confirm their answers are true' } });
  }

  const { device, browser } = describeAgent(req.headers['user-agent']);

  const { rows } = await pool.query(
    `INSERT INTO pt_consent_records (
       parq_form_id, client_id, consent_checkboxes, client_signature, trainer_signature,
       client_signed_at, trainer_signed_at, ip_address, device, browser, location, organization_id
     ) VALUES ($1,$2,$3::jsonb,$4,$5,NOW(),NOW(),$6,$7,$8,$9,$10) RETURNING *`,
    [
      formId, form.client_id, JSON.stringify(checkboxes), b.client_signature || null, b.trainer_signature || null,
      req.ip || null, device, browser, b.location || null, form.organization_id,
    ]
  );
  let consentRecord = rows[0];

  // PDF generation failure shouldn't fail the consent capture itself — the
  // signed record is already durably stored; the PDF can be regenerated.
  try {
    const [formRes2, clearanceRes2] = await Promise.all([
      pool.query('SELECT * FROM pt_parq_forms WHERE id = $1', [formId]),
      pool.query('SELECT * FROM pt_medical_clearances WHERE parq_form_id = $1 ORDER BY created_at DESC LIMIT 1', [formId]),
    ]);
    const pdfUrl = await generateConsentPdf({
      form: formRes2.rows[0], clearance: clearanceRes2.rows[0] || null, consent: consentRecord,
    });
    const { rows: updatedRows } = await pool.query(
      'UPDATE pt_consent_records SET pdf_url = $1 WHERE id = $2 RETURNING *', [pdfUrl, consentRecord.id]
    );
    consentRecord = updatedRows[0];
  } catch (err) {
    logger.error({ err: err.message, formId }, 'parq consent PDF generation failed');
  }

  await logActivity(req, 'parq.consent.sign', 'pt_consent_records', consentRecord.id, { formId });
  res.status(201).json({ data: consentRecord });
}));

// ─── Document Uploads ───────────────────────────────────────

// Multer + memoryStorage + magic-byte-sniff, following the pattern in
// src/routes/profile.js's avatar upload — MIME header alone can be spoofed,
// so the actual file bytes are checked before trusting the extension.
const PARQ_MAX_UPLOAD_BYTES = parseInt(process.env.PARQ_MAX_UPLOAD_BYTES, 10) || 10 * 1024 * 1024; // 10MB default, configurable
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PARQ_MAX_UPLOAD_BYTES },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g)$|^application\/pdf$/i.test(file.mimetype || '')) {
      return cb(invalidFileType('Only PNG, JPG, or PDF files are allowed'));
    }
    cb(null, true);
  },
});


const DOC_TYPES = ['medical_report', 'medical_certificate', 'other'];

// POST /parq/forms/:formId/documents
router.post('/parq/forms/:formId/documents', auth, requireTrainer, docUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File is required' });

  const { formId } = req.params;
  const scope = tenantScope(req);
  const dGuard = ' AND organization_id = $2';
  const { rows: formRows } = await pool.query(
    `SELECT client_id, organization_id FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${dGuard}`,
    [formId, scope.orgId]
  );
  const form = formRows[0];
  if (!form) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const detected = detectFileType(req.file.buffer, DOCUMENTS);
  if (!detected) {
    return res.status(400).json({ error: 'File content does not match an allowed type (PNG, JPG, PDF)' });
  }

  const docType = DOC_TYPES.includes(req.body.doc_type) ? req.body.doc_type : 'other';

  const filename = `${formId}-${Date.now()}.${detected.ext}`;
  const fileUrl = await saveFile('parq', filename, req.file.buffer, detected.mime,
    { organizationId: req.user?.organization_id, uploadedBy: req.user?.id });

  const { rows } = await pool.query(
    `INSERT INTO pt_parq_documents (parq_form_id, client_id, doc_type, file_name, file_url, mime_type, size_bytes, uploaded_by, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [formId, form.client_id, docType, req.file.originalname || filename, fileUrl, detected.mime, req.file.size, req.user.id, form.organization_id]
  );
  res.status(201).json({ data: rows[0] });
}));

module.exports = router;
