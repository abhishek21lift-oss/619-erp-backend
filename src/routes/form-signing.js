'use strict';
// Public remote signing — the client's side of a one-time form link.
//
// Mounted at /api/public/form-signing with NO auth: the token in the URL is
// the only credential, exactly like /api/client-activation. That is why every
// read is pinned to the token's own organization and client, and why the
// identity fields on the forms are filled from pt_clients server-side — the
// browser cannot choose whose name is signed.
//
// One submission writes all three records the trainer's in-person flow writes:
//   pt_parq_forms        the screening answers
//   pt_consent_records   the PAR-Q "these answers are true" signature
//   pt_informed_consents the legal consent, signed by the client, waiting for
//                        the trainer's countersignature
// The link is spent in the same transaction, so a retried POST cannot write a
// second screening.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { makeStore } = require('../lib/rateLimitStore');
const pool = require('../db/pool');
const logger = require('../lib/logger');
const { validate } = require('../middleware/validate');
const { z } = require('../lib/validation');
const { logActivity } = require('../lib/activityLog');
const { signatureDataUrl, describeAgent } = require('../lib/signing');
const { computeParqAnalysis } = require('../modules/pt-os/parq-scoring');
const { maybeActivateClient, PARQ_QUESTION_COUNT } = require('../lib/screeningGate');
const { generateConsentPdf } = require('../lib/parqPdf');
const { ACK_KEYS } = require('../modules/pt-os/informed-consent.routes');
const formLinks = require('../lib/formLinks');
const remoteSigning = require('../modules/remote-signing/remote-signing.service');

const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Public and token-guessing-adjacent, so its own limiter. Generous enough that
// one person filling one long form is never blocked.
const signingLimiter = rateLimit({
  store: makeStore('form-signing'),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
});
router.use(signingLimiter);

const numOpt = () => z.coerce.number().optional().nullable();

const parqAnswerSchema = z.object({
  question_id: z.coerce.number().int().min(1).max(PARQ_QUESTION_COUNT),
  answer: z.enum(['yes', 'no']),
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

const submitSchema = {
  body: z.object({
    height_cm: numOpt(),
    weight_kg: numOpt(),
    current_health: z.record(z.string(), z.unknown()).optional().nullable(),
    past_history: z.record(z.string(), z.unknown()).optional().nullable(),
    family_history: z.array(familyHistorySchema).max(10).optional().nullable(),
    parq_answers: z.array(parqAnswerSchema).max(PARQ_QUESTION_COUNT)
      .refine((list) => new Set(list.map((a) => a.question_id)).size === list.length,
        { message: 'Each PAR-Q question may be answered once' }),
    acknowledgements: z.record(z.string(), z.boolean()),
    physician_advised_against: z.boolean().optional().nullable(),
    physician_name: z.string().max(255).optional().nullable(),
    hospital: z.string().max(255).optional().nullable(),
    medical_condition: z.string().max(1000).optional().nullable(),
    exercise_consent_checked: z.literal(true),
    exercise_consent_text: z.string().min(1).max(8000),
    // The client signs once. That signature covers the PAR-Q answers and the
    // informed consent; the trainer countersigns the consent later.
    signature: signatureDataUrl,
  }),
};

const LINK_INVALID = {
  error: { code: 'LINK_INVALID', message: 'This signing link is invalid, has expired, or has already been used.' },
};

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

function calcBmi(weightKg, heightCm) {
  const w = Number(weightKg);
  const h = Number(heightCm);
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return null;
  const heightM = h / 100;
  return Math.round((w / (heightM * heightM)) * 10) / 10;
}

function maskEmail(value) {
  const s = String(value || '');
  const at = s.indexOf('@');
  if (at < 1) return null;
  return `${s[0]}${'*'.repeat(Math.min(3, Math.max(1, at - 1)))}${s.slice(at)}`;
}

// GET /api/public/form-signing/:token — enough to greet the client and prove
// the link is live. No identity beyond the name the trainer already knows.
router.get('/:token', wrap(async (req, res) => {
  const link = await formLinks.resolve(req.params.token);
  if (!link) return res.status(404).json(LINK_INVALID);
  res.json({
    data: {
      client_name: link.client_name,
      studio_name: link.studio_name || 'Your studio',
      email: maskEmail(link.email),
      expires_at: link.expires_at,
    },
  });
}));

// POST /api/public/form-signing/:token
router.post('/:token', validate(submitSchema), wrap(async (req, res) => {
  const link = await formLinks.resolve(req.params.token);
  if (!link) return res.status(404).json(LINK_INVALID);

  const b = req.body;
  const missing = unansweredQuestions(b.parq_answers);
  if (missing.length) {
    return res.status(400).json({
      error: { code: 'INCOMPLETE_PARQ', message: 'Every PAR-Q question needs an answer.', missing },
    });
  }
  if (!ACK_KEYS.every((k) => b.acknowledgements[k] === true)) {
    return res.status(400).json({
      error: { code: 'ACKNOWLEDGEMENTS_INCOMPLETE', message: 'All agreement items must be accepted before signing.' },
    });
  }

  const analysis = computeParqAnalysis(b.parq_answers);
  const bmi = calcBmi(b.weight_kg, b.height_cm);
  const { device, browser } = describeAgent(req.get('user-agent'));
  const ip = req.ip || null;

  const tx = await pool.connect();
  let written;
  try {
    await tx.query('BEGIN');
    // Spend the link first: the loser of two concurrent submissions rolls
    // back before writing anything.
    if (!await formLinks.markUsed(link.id, { client: tx })) {
      await tx.query('ROLLBACK');
      return res.status(409).json({
        error: { code: 'LINK_USED', message: 'This screening has already been submitted.' },
      });
    }
    written = await remoteSigning.writeSignedForms(tx, link, b, analysis, bmi, { device, browser, ip });
    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }

  // PDF after commit: the signed row is already durable, and a PDF failure
  // must not turn a completed signing into an error the client retries.
  try {
    const { form, consent } = await remoteSigning.loadSignedForms(written.formId, written.consentRecordId);
    const pdfUrl = await generateConsentPdf({ form, clearance: null, consent });
    await remoteSigning.attachConsentPdf(written.consentRecordId, pdfUrl);
  } catch (err) {
    logger.error({ err: err.message, formId: written.formId }, 'remote parq consent PDF generation failed');
  }

  // A req-like object: the audit helper and the activation check read the
  // trainer off it, and here there is no session — only the link's issuer.
  const actor = {
    user: {
      id: link.created_by || null,
      name: 'Client (remote signing)',
      organization_id: link.organization_id,
    },
    ip,
    headers: req.headers,
    get: (h) => req.get(h),
  };
  await maybeActivateClient(actor, link.client_id);
  await logActivity(actor, 'parq.submit', 'pt_parq_forms', written.formId, {
    client_id: link.client_id, risk_level: analysis.riskLevel,
    yes_count: analysis.yesCount, remote: true,
  });
  await logActivity(actor, 'parq.consent.sign', 'pt_consent_records', written.consentRecordId, {
    formId: written.formId, remote: true,
  });
  if (written.informedConsentId) {
    await logActivity(actor, 'informed_consent.sign.client', 'pt_informed_consents', written.informedConsentId, {
      remote: true,
    });
  }

  res.status(201).json({
    data: { parq_form_id: written.formId, risk_level: analysis.riskLevel },
  });
}));

module.exports = router;
