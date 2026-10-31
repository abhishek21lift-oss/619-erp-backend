'use strict';
// src/modules/form-checks/form-check.routes.js
// Trainer side of asynchronous form review. A member uploads a lift video
// (client-portal.routes.js); this is the queue, the timestamped comments and
// the reviewed mark.
//
// Every read and write is scoped to the caller's organization by the service.
// Nothing here takes an organization id from the request, and a check in
// another studio answers 404 rather than 403 — the id must look like one that
// does not exist.

const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { orgIdOf } = require('../../lib/tenant-db');
const service = require('./form-check.service');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const STATUSES = ['pending', 'reviewed', 'all'];
const bad = (res, message) => res.status(400).json({ error: { code: 'VALIDATION', message } });
const notFound = (res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Form check not found' } });

// GET /form-checks?status=pending|reviewed|all — the review queue.
//
// Pending is the default: the queue exists to show what still needs watching.
// comment_count is the trainer's own progress signal, so the list can say
// "2 comments" without opening every video.
router.get('/form-checks', auth, wrap(async (req, res) => {
  const status = req.query.status === undefined ? 'pending' : String(req.query.status);
  if (!STATUSES.includes(status)) return bad(res, "status must be 'pending', 'reviewed' or 'all'");
  res.json({ data: await service.listQueue(orgIdOf(req), status) });
}));

// GET /form-checks/:id — one check, its video and every comment.
router.get('/form-checks/:id', auth, wrap(async (req, res) => {
  const detail = await service.detailForTrainer(orgIdOf(req), req.params.id);
  if (!detail) return notFound(res);
  res.json({ data: detail });
}));

// POST /form-checks/:id/comments — one observation pinned to a second.
// Adding a comment does not mark the check reviewed; those are separate claims.
router.post('/form-checks/:id/comments', auth, wrap(async (req, res) => {
  const atSeconds = Number(req.body?.at_seconds);
  if (!Number.isInteger(atSeconds) || atSeconds < 0) {
    return bad(res, 'at_seconds must be a whole number of seconds, 0 or more');
  }
  const body = String(req.body?.body ?? '').trim();
  if (!body) return bad(res, 'Write the comment first');
  if (body.length > 1000) return bad(res, 'Keep the comment to 1000 characters');

  const comment = await service.addComment(orgIdOf(req), req.params.id, atSeconds, body);
  if (!comment) return notFound(res);
  res.status(201).json({ data: comment });
}));

// POST /form-checks/:id/reviewed — the trainer says this video is done.
router.post('/form-checks/:id/reviewed', auth, wrap(async (req, res) => {
  const row = await service.markReviewed(orgIdOf(req), req.params.id);
  if (!row) return notFound(res);
  res.json({ data: row });
}));

module.exports = router;
