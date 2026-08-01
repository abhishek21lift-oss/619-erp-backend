'use strict';
// The exercise library HTTP surface.
//
// Thin by design: every rule lives in exercises.service.js, and these
// handlers only translate between HTTP and it. The one thing they do own is
// turning a unique-constraint violation into a field-level 409, because the
// service's pre-check cannot close that race on its own.

const router = require('express').Router();
const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const { auth } = require('../../middleware/auth');
const { tenantScope } = require('../../lib/tenant-db');
const svc = require('./exercises.service');

/** Role gate for anything that writes. Read is open to any authenticated user. */
function canWrite(req, res, next) {
  if (!svc.canCreate(req.user)) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'You do not have permission to modify exercises' },
    });
  }
  next();
}

const ctx = (req) => ({ user: req.user, orgId: tenantScope(req).orgId });

/** 23505 on the name index is a duplicate; on the slug index it is a race. */
function handleWriteError(err, res, next) {
  if (err.code === '23505') {
    const c = String(err.constraint || '');
    if (c.includes('name_per_org')) {
      return res.status(409).json({
        error: {
          code: 'DUPLICATE_NAME',
          message: 'An exercise with this name already exists in your library.',
          field: 'name',
        },
      });
    }
    if (c.includes('slug')) {
      return res.status(409).json({
        error: { code: 'SLUG_CONFLICT', message: 'That URL name is taken — try saving again.' },
      });
    }
  }
  if (err.code === '23514') {
    return res.status(400).json({
      error: { code: 'VALIDATION', message: 'One of the values is not allowed for its field.' },
    });
  }
  return next(err);
}

// ── Reads ───────────────────────────────────────────────────────────────────

// GET /api/exercises
router.get('/', auth, async (req, res, next) => {
  try {
    const result = await svc.list(pool, { query: req.query, ...ctx(req) });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/exercises/meta — filter dropdown values
router.get('/meta', auth, async (req, res, next) => {
  try {
    res.json(await svc.meta(pool, ctx(req)));
  } catch (err) { next(err); }
});

// GET /api/exercises/favorites — this user's shortlist
router.get('/favorites', auth, async (req, res, next) => {
  try {
    const result = await svc.list(pool, {
      query: { ...req.query, favorites: 'true' }, ...ctx(req),
    });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/exercises/recent — what this user reached for last
router.get('/recent', auth, async (req, res, next) => {
  try {
    const result = await svc.list(pool, {
      query: { ...req.query, sort: 'recent', limit: req.query.limit || 12 }, ...ctx(req),
    });
    // sort=recent puts never-used rows last; the caller asked for recents only.
    res.json({ ...result, data: result.data.filter((r) => r.last_used_at) });
  } catch (err) { next(err); }
});

// Registered after the literal paths above so /meta, /favorites and /recent
// are never swallowed by :idOrSlug.
// GET /api/exercises/:idOrSlug
router.get('/:idOrSlug', auth, async (req, res, next) => {
  try {
    const exercise = await svc.getById(pool, req.params.idOrSlug, ctx(req));
    if (!exercise) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Exercise not found' } });
    }
    res.json({ data: exercise });
  } catch (err) { next(err); }
});

// GET /api/exercises/:id/versions
router.get('/:id/versions', auth, async (req, res, next) => {
  try {
    const exercise = await svc.getById(pool, req.params.id, ctx(req));
    if (!exercise) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Exercise not found' } });
    }
    res.json({ data: await svc.versions(pool, exercise.id) });
  } catch (err) { next(err); }
});

// ── Writes ──────────────────────────────────────────────────────────────────

// POST /api/exercises
router.post('/', auth, canWrite, async (req, res, next) => {
  try {
    const result = await svc.create(pool, { body: req.body, ...ctx(req) });
    if (result.errors) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Please correct the highlighted fields', fields: result.errors },
      });
    }
    if (result.duplicate) {
      return res.status(409).json({
        error: {
          code: 'DUPLICATE_NAME',
          message: `"${result.duplicate.name}" already exists in your library.`,
          field: 'name',
          existing: result.duplicate,
        },
      });
    }
    res.status(201).json({ data: result.exercise });
  } catch (err) { handleWriteError(err, res, next); }
});

// POST /api/exercises/check-name — live duplicate detection for the creator UI
router.post('/check-name', auth, canWrite, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.json({ available: false, reason: 'Name is required' });
    const { orgId } = ctx(req);
    const dupe = await svc.findDuplicateName(pool, name, orgId, { excludeId: req.body?.exclude_id || null });
    res.json({
      available: !dupe,
      slug: svc.slugify(name),
      existing: dupe || null,
    });
  } catch (err) { next(err); }
});

// PUT /api/exercises/:id
router.put('/:id', auth, canWrite, async (req, res, next) => {
  try {
    const result = await svc.update(pool, req.params.id, {
      body: req.body, changeNote: req.body?.change_note, ...ctx(req),
    });
    if (result.denied) {
      return res.status(result.denied.status).json({
        error: { code: 'FORBIDDEN', message: result.denied.message },
      });
    }
    if (result.errors) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Please correct the highlighted fields', fields: result.errors },
      });
    }
    if (result.duplicate) {
      return res.status(409).json({
        error: {
          code: 'DUPLICATE_NAME',
          message: `"${result.duplicate.name}" already exists in your library.`,
          field: 'name',
          existing: result.duplicate,
        },
      });
    }
    res.json({ data: result.exercise });
  } catch (err) { handleWriteError(err, res, next); }
});

// POST /api/exercises/:id/duplicate
router.post('/:id/duplicate', auth, canWrite, async (req, res, next) => {
  try {
    const result = await svc.duplicate(pool, req.params.id, { name: req.body?.name, ...ctx(req) });
    if (result.denied) {
      return res.status(result.denied.status).json({
        error: { code: 'FORBIDDEN', message: result.denied.message },
      });
    }
    if (result.errors) {
      return res.status(400).json({ error: { code: 'VALIDATION', fields: result.errors } });
    }
    res.status(201).json({ data: result.exercise });
  } catch (err) { handleWriteError(err, res, next); }
});

for (const action of ['archive', 'restore']) {
  router.post(`/:id/${action}`, auth, canWrite, async (req, res, next) => {
    try {
      const result = await svc.setLifecycle(pool, req.params.id, { action, ...ctx(req) });
      if (result.denied) {
        return res.status(result.denied.status).json({
          error: { code: 'FORBIDDEN', message: result.denied.message },
        });
      }
      res.json({ data: { id: req.params.id, action } });
    } catch (err) { next(err); }
  });
}

// DELETE /api/exercises/:id — soft delete; history keeps referencing the row.
router.delete('/:id', auth, canWrite, async (req, res, next) => {
  try {
    const result = await svc.setLifecycle(pool, req.params.id, { action: 'delete', ...ctx(req) });
    if (result.denied) {
      return res.status(result.denied.status).json({
        error: { code: 'FORBIDDEN', message: result.denied.message },
      });
    }
    res.json({ data: { id: req.params.id, deleted: true } });
  } catch (err) { next(err); }
});

// ── Favourites and recents ──────────────────────────────────────────────────
// Open to any authenticated user, including staff: a favourite is a personal
// bookmark, not a change to the library.

router.put('/:id/favorite', auth, async (req, res, next) => {
  try {
    await svc.setFavorite(pool, { userId: req.user.id, exerciseId: req.params.id, favorite: true });
    res.json({ data: { id: req.params.id, is_favorite: true } });
  } catch (err) { next(err); }
});

router.delete('/:id/favorite', auth, async (req, res, next) => {
  try {
    await svc.setFavorite(pool, { userId: req.user.id, exerciseId: req.params.id, favorite: false });
    res.json({ data: { id: req.params.id, is_favorite: false } });
  } catch (err) { next(err); }
});

// POST /api/exercises/record-use — called when exercises are added to a plan.
// Best-effort by design: a failure here must never fail the save that
// triggered it, so it answers 204 regardless.
router.post('/record-use', auth, async (req, res) => {
  try {
    await svc.recordUse(pool, {
      userId: req.user.id,
      exerciseIds: req.body?.exercise_ids || req.body?.exercise_id,
    });
  } catch (err) {
    logger.warn({ err: err.message, userId: req.user.id }, 'exercise recent-use write failed');
  }
  res.status(204).end();
});

// PUT /api/exercises/:id/relations — regressions / progressions / alternatives
router.put('/:id/relations', auth, canWrite, async (req, res, next) => {
  try {
    const kind = req.body?.kind;
    if (!['regression', 'progression', 'alternative'].includes(kind)) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'kind must be regression, progression or alternative' },
      });
    }
    const { rows } = await pool.query(
      'SELECT * FROM exercises WHERE id = $1 AND deleted_at IS NULL', [req.params.id]
    );
    const permitted = svc.canModify(req.user, rows[0]);
    if (!permitted.ok) {
      return res.status(permitted.status).json({ error: { code: 'FORBIDDEN', message: permitted.message } });
    }
    await svc.setRelations(pool, req.params.id, { kind, relatedIds: req.body?.related_ids || [] });
    res.json({ data: { id: req.params.id, kind } });
  } catch (err) { next(err); }
});

module.exports = router;
