'use strict';
// Post-session feedback endpoints.
//
// Two routers, mounted in server.js behind different doors:
//   member  → /api/me   (auth + requireClient; identity from req.user)
//   trainer → /api/pt-os (auth + requireTrainer; org from req.user)
//
// Neither router accepts an organization id. The member router does not accept
// a client id either, so there is nothing to tamper with.

const express = require('express');
const { z } = require('../../lib/validation');
const { validate } = require('../../middleware/validate');
const { OPTIONS } = require('../../lib/sessionFeedback');
const { logActivity } = require('../../lib/activityLog');
const svc = require('./feedback.service');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const submitSchema = z.object({
  trainer_behaviour: z.enum(OPTIONS.trainer_behaviour),
  form_technique: z.enum(OPTIONS.form_technique),
  workout_intensity: z.enum(OPTIONS.workout_intensity),
  motivation_guidance: z.enum(OPTIONS.motivation_guidance),
  overall_stars: z.number().int().min(1).max(5),
  // The optional free-text answer. Deliberately capped: this field is read by
  // a human, and a session's rating is not the place for an essay.
  additional_feedback: z.string().trim().max(2000).optional().nullable(),
});

const memberQuery = z.object({
  status: z.enum(['pending', 'submitted', 'all']).optional(),
});

const trainerQuery = z.object({
  trainer_id: z.string().max(64).optional(),
  client_id: z.string().max(64).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD').optional(),
  min_score: z.coerce.number().min(0).max(5).optional(),
  max_score: z.coerce.number().min(0).max(5).optional(),
  flagged: z.enum(['0', '1', 'true', 'false']).optional(),
  status: z.enum(['pending', 'submitted', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ── Member ──────────────────────────────────────────────────────────────────

const member = express.Router();

member.get('/feedback', validate({ query: memberQuery }), wrap(async (req, res) => {
  const rows = await svc.listForClient({
    clientId: req.user.pt_client_id,
    orgId: req.user.organization_id,
    status: req.query.status || 'all',
  });
  res.json({ data: rows });
}));

member.post('/feedback/:id', validate({ body: submitSchema }), wrap(async (req, res) => {
  const result = await svc.submitFeedback({
    feedbackId: req.params.id,
    clientId: req.user.pt_client_id,
    orgId: req.user.organization_id,
    answers: req.body,
  });

  if (result.notFound) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Feedback request not found.' },
    });
  }
  if (result.duplicate) {
    return res.status(409).json({
      error: { code: 'ALREADY_SUBMITTED', message: 'This session has already been rated.' },
    });
  }
  // The audit trail records that the client submitted, not what they said:
  // the answers are already the row, and copying free text into activity_log
  // would put a client's words in a second place with its own retention.
  await logActivity(req, 'session_feedback.submit', 'pt_session_feedback', result.row.id, {
    session_id: result.row.session_id, score: result.row.score,
  });
  res.json({ data: result.row });
}));

// ── Studio ──────────────────────────────────────────────────────────────────

const trainer = express.Router();

// Before /feedback/:id, or "summary" would be read as an id.
trainer.get('/feedback/summary', wrap(async (req, res) => {
  res.json({ data: await svc.summaryForTrainer(req.user.organization_id) });
}));

trainer.get('/feedback', validate({ query: trainerQuery }), wrap(async (req, res) => {
  const q = req.query;
  const result = await svc.listForTrainer(req.user.organization_id, {
    trainer_id: q.trainer_id,
    client_id: q.client_id,
    from: q.from,
    to: q.to,
    min_score: q.min_score,
    max_score: q.max_score,
    flagged: q.flagged === '1' || q.flagged === 'true',
    status: q.status,
    limit: q.limit,
    offset: q.offset,
  });
  res.json({ data: result.rows, total: result.total });
}));

trainer.get('/feedback/:id', wrap(async (req, res) => {
  const row = await svc.getForTrainer(req.user.organization_id, req.params.id);
  if (!row) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Feedback not found.' },
    });
  }
  res.json({ data: row });
}));

module.exports = { member, trainer };
