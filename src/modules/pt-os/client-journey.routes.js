'use strict';
// The intake journey and the Client Interview. A thin adapter: the SQL and
// the rules are in client-journey.service.js. Mounted under /api/pt-os behind
// auth + requireTrainer (server.js); every call is scoped to the caller's
// studio through orgIdOf(req), never to an id from the request.

const router = require('express').Router();
const { auth, requireTrainer } = require('../../middleware/auth');
const { orgIdOf } = require('../../lib/tenant-db');
const { logActivity } = require('../../lib/activityLog');
const svc = require('./client-journey.service');

router.use(auth, requireTrainer);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Client not found' } };

/** An interview input error as a 4xx; anything else to the error handler. */
function inputError(res, err) {
  if (!(err instanceof svc.InterviewInputError)) return false;
  res.status(err.status).json({ error: { code: err.status === 409 ? 'CONFLICT' : 'VALIDATION', message: err.message } });
  return true;
}

// GET /pt-os/clients/:id/journey — every step's state, and the next one.
router.get('/clients/:id/journey', wrap(async (req, res) => {
  const out = await svc.journey(orgIdOf(req), req.params.id);
  if (!out) return res.status(404).json(NOT_FOUND);
  res.json({ data: out });
}));

// GET /pt-os/clients/:id/interviews — newest first.
router.get('/clients/:id/interviews', wrap(async (req, res) => {
  const rows = await svc.listInterviews(orgIdOf(req), req.params.id);
  if (!rows) return res.status(404).json(NOT_FOUND);
  res.json({ data: rows });
}));

// POST /pt-os/clients/:id/interviews — start (or record) an interview.
router.post('/clients/:id/interviews', wrap(async (req, res) => {
  try {
    const row = await svc.createInterview(orgIdOf(req), req.params.id, req.user.id, req.body || {});
    if (!row) return res.status(404).json(NOT_FOUND);
    await logActivity(req, 'client.interview.create', 'pt_client', req.params.id, { interview_id: row.id, status: row.status });
    res.status(201).json({ data: row });
  } catch (err) {
    if (!inputError(res, err)) throw err;
  }
}));

// PATCH /pt-os/interviews/:id — edit, or complete.
router.patch('/interviews/:id', wrap(async (req, res) => {
  try {
    const row = await svc.updateInterview(orgIdOf(req), req.params.id, req.user.id, req.body || {});
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Interview not found' } });
    await logActivity(req, 'client.interview.update', 'pt_client', row.client_id, { interview_id: row.id, status: row.status });
    res.json({ data: row });
  } catch (err) {
    if (!inputError(res, err)) throw err;
  }
}));

module.exports = router;
