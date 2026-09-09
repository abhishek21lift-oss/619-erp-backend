// HTTP for the training domain, mounted at /api/training.
//
// ── Why not /api/workouts ──────────────────────────────────────────────────
//
// That path belongs to the old routes and still serves production. Mounting
// the new domain beside it rather than over it keeps this slice additive: the
// two can run together while the UI is rebuilt, and slice G repoints the old
// path once nothing reads it. Taking the path now would mean cutting over the
// frontend in the same change that introduces the API.
//
// ── What lives here and what does not ──────────────────────────────────────
//
// These handlers validate, authorise, and call. Anything spanning two tables,
// anything needing a transaction, and every coaching rule lives in
// training.service.js and the pure modules beside it. A handler that grew SQL
// is a handler that will grow a second copy of a rule.
//
// That is now literally true rather than aspirational: this file holds no SQL
// and does not import the pool. Every read and write goes through
// training.repository.js, and architecture.layering.convention.test.js fails
// the build if a query comes back — the file is no longer in its debt
// register, so its allowance is zero.
//
// Authorisation is never inline. Every route reaches its row through authz.js,
// which walks back to the client — because `WHERE id = $1` on a child table
// looks scoped and is not.
'use strict';

const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const { logActivity } = require('../../lib/activityLog');
const authz = require('./authz');
const schemas = require('./training.schemas');
const service = require('./training.service');
const repo = require('./training.repository');
const prescription = require('./prescription');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Staff who may author or log. Clients read through a separate surface. */
const STAFF = requireRole('admin', 'manager', 'trainer');

const notFound = (res, what) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `${what} not found` } });

/** Turn a TrainingError into its response; re-throw anything else. */
function sendError(res, err) {
  if (!(err instanceof service.TrainingError)) throw err;
  if (err.body) return res.status(err.status).json(err.body);
  return res.status(err.status).json({ error: { code: err.code, message: err.message } });
}

// ═══ Programs ══════════════════════════════════════════════════════════════

router.get('/programs', auth, STAFF, wrap(async (req, res) => {
  const rows = await repo.listPrograms(req, {
    clientId: req.query.client_id,
    status: req.query.status,
  });
  res.json({ data: rows });
}));

router.get('/programs/:id', auth, STAFF, wrap(async (req, res) => {
  const program = await authz.loadOwned(req, 'training_programs', req.params.id);
  if (!program) return notFound(res, 'Program');
  const { phases, weeks } = await repo.loadProgramParts(program.id);
  res.json({ data: { ...program, phases, weeks } });
}));

router.post('/programs', auth, STAFF, validate(schemas.programCreate), wrap(async (req, res) => {
  const b = req.body;
  if (b.client_id && !await authz.canAccessClient(req, b.client_id)) return notFound(res, 'Client');
  const program = await repo.createProgram(req, b);
  await logActivity(req, 'training.program.create', 'training_programs', program.id, { name: b.name }).catch(() => {});
  res.status(201).json({ data: program });
}));

router.patch('/programs/:id', auth, STAFF, validate(schemas.programUpdate), wrap(async (req, res) => {
  if (!await authz.loadOwned(req, 'training_programs', req.params.id)) return notFound(res, 'Program');
  // client_id is patchable, and POST /programs guards the same field with this
  // exact check. Without it here, a programme this studio legitimately owns
  // could be re-pointed at ANOTHER studio's client — not a read of foreign
  // data, but a foreign key written across the tenant boundary, which leaves
  // the row reachable from two studios' client views.
  //
  // It stays in the adapter on purpose: it is an authorisation decision about
  // the request, and authorisation is what this layer is for. The repository
  // is told which row to write, never whether the caller may.
  if (req.body.client_id !== undefined && req.body.client_id !== null
      && !await authz.canAccessClient(req, req.body.client_id)) {
    return notFound(res, 'Client');
  }
  const program = await repo.updateProgram(req.params.id, req.body);
  // null means the body named no patchable field — answered exactly as before.
  if (!program) return notFound(res, 'Nothing to update');
  res.json({ data: program });
}));

router.delete('/programs/:id', auth, STAFF, wrap(async (req, res) => {
  if (!await authz.loadOwned(req, 'training_programs', req.params.id)) return notFound(res, 'Program');
  await repo.softDeleteProgram(req.params.id);
  await logActivity(req, 'training.program.delete', 'training_programs', req.params.id, {}).catch(() => {});
  res.json({ data: { id: req.params.id, deleted: true } });
}));

router.post('/programs/:id/phases', auth, STAFF, validate(schemas.phaseCreate), wrap(async (req, res) => {
  if (!await authz.loadOwned(req, 'training_programs', req.params.id)) return notFound(res, 'Program');
  res.status(201).json({ data: await repo.createPhase(req.params.id, req.body) });
}));

router.post('/programs/:id/weeks', auth, STAFF, validate(schemas.weekCreate), wrap(async (req, res) => {
  if (!await authz.loadOwned(req, 'training_programs', req.params.id)) return notFound(res, 'Program');
  res.status(201).json({ data: await repo.upsertWeek(req.params.id, req.body) });
}));

// ═══ Templates and prescriptions ═══════════════════════════════════════════

router.get('/templates', auth, STAFF, wrap(async (req, res) => {
  const rows = await repo.listTemplates(req, {
    programId: req.query.program_id,
    weekId: req.query.week_id,
  });
  res.json({ data: rows });
}));

router.get('/templates/:id', auth, STAFF, wrap(async (req, res) => {
  const template = await authz.loadOwned(req, 'workout_templates', req.params.id);
  if (!template) return notFound(res, 'Workout template');
  const rows = await repo.loadTemplateExercises(template.id);
  // The sentence a trainer would say, built once here rather than in each of
  // the PDF, the client screen and the AI brief.
  const exercises = rows.map((r) => ({
    ...r,
    summary: prescription.describe(r, r.exercise_name || ''),
    logs_as: prescription.performanceKind(r.prescription_type),
  }));
  res.json({ data: { ...template, exercises } });
}));

router.post('/templates', auth, STAFF, validate(schemas.templateCreate), wrap(async (req, res) => {
  const b = req.body;
  if (b.program_id && !await authz.loadOwned(req, 'training_programs', b.program_id)) {
    return notFound(res, 'Program');
  }
  const template = await repo.createTemplate(req, b);
  await logActivity(req, 'training.template.create', 'workout_templates', template.id, { name: b.name }).catch(() => {});
  res.status(201).json({ data: template });
}));

router.post('/templates/:id/exercises', auth, STAFF, validate(schemas.prescriptionCreate),
  wrap(async (req, res) => {
    const template = await authz.loadOwned(req, 'workout_templates', req.params.id);
    if (!template) return notFound(res, 'Workout template');

    const row = { ...req.body, prescription_type: req.body.prescription_type ?? 'SETS_REPS' };
    // Shape and range were checked by zod; THIS checks the prescription
    // against its own type, which only prescription.js knows how to do.
    const check = prescription.validate(row);
    if (!check.valid) {
      return res.status(400).json({
        error: { code: 'INVALID_PRESCRIPTION', message: check.errors[0], details: check.errors },
      });
    }

    const created = await repo.createPrescription(template.id, row);
    res.status(201).json({ data: created, warnings: check.warnings });
  }));

router.patch('/templates/:tid/exercises/:id', auth, STAFF, validate(schemas.prescriptionUpdate),
  wrap(async (req, res) => {
    const template = await authz.loadOwned(req, 'workout_templates', req.params.tid);
    if (!template) return notFound(res, 'Workout template');

    const existing = await repo.loadPrescription(template.id, req.params.id);
    if (!existing) return notFound(res, 'Prescription');

    // Validate the MERGED row, not the patch: a patch that only changes
    // prescription_type is valid on its own and can leave the row saying
    // nothing.
    const merged = { ...existing, ...req.body };
    const check = prescription.validate(merged);
    if (!check.valid) {
      return res.status(400).json({
        error: { code: 'INVALID_PRESCRIPTION', message: check.errors[0], details: check.errors },
      });
    }

    // null means the body named no patchable field — answered with the row as
    // it stands, exactly as before.
    const updated = await repo.updatePrescription(req.params.id, req.body);
    res.json({ data: updated ?? existing, warnings: check.warnings });
  }));

router.delete('/templates/:tid/exercises/:id', auth, STAFF, wrap(async (req, res) => {
  const template = await authz.loadOwned(req, 'workout_templates', req.params.tid);
  if (!template) return notFound(res, 'Workout template');
  if (!await repo.deletePrescription(template.id, req.params.id)) return notFound(res, 'Prescription');
  res.json({ data: { id: req.params.id, deleted: true } });
}));

router.put('/templates/:id/order', auth, STAFF, validate(schemas.reorder), wrap(async (req, res) => {
  const template = await authz.loadOwned(req, 'workout_templates', req.params.id);
  if (!template) return notFound(res, 'Workout template');
  const reordered = await repo.reorderPrescriptions(template.id, req.body.exercise_ids);
  res.json({ data: { id: template.id, reordered } });
}));

// ═══ Assignments ═══════════════════════════════════════════════════════════

router.get('/assignments', auth, STAFF, wrap(async (req, res) => {
  const rows = await repo.listAssignments(req, {
    clientId: req.query.client_id,
    date: req.query.date,
    status: req.query.status,
  });
  res.json({ data: rows });
}));

router.post('/assignments', auth, STAFF, validate(schemas.assignmentCreate), wrap(async (req, res) => {
  const b = req.body;
  if (!await authz.canAccessClient(req, b.client_id)) return notFound(res, 'Client');
  if (!await authz.loadOwned(req, 'workout_templates', b.workout_template_id)) {
    return notFound(res, 'Workout template');
  }

  // The same gate as logging a session. Assigning a plan to a client the
  // screening has flagged must fail for the same reason training them does.
  const { checkScreeningGate } = require('../../lib/screeningGate');
  const { blocked, warnings } = await checkScreeningGate(req, b.client_id);
  if (blocked) return res.status(blocked.status).json(blocked.body);

  const assignment = await repo.createAssignment(req, b);
  await logActivity(req, 'training.assignment.create', 'training_assignments', assignment.id,
    { client_id: b.client_id }).catch(() => {});
  res.status(201).json({ data: assignment, screening_warnings: warnings });
}));

router.patch('/assignments/:id', auth, STAFF, validate(schemas.assignmentUpdate), wrap(async (req, res) => {
  if (!await authz.loadOwned(req, 'training_assignments', req.params.id)) return notFound(res, 'Assignment');
  const assignment = await repo.updateAssignment(req.params.id, req.body);
  if (!assignment) return notFound(res, 'Nothing to update');
  res.json({ data: assignment });
}));

// ═══ Sessions ══════════════════════════════════════════════════════════════

router.get('/sessions', auth, STAFF, wrap(async (req, res) => {
  // Clamped here rather than in the repository: reading a query string is what
  // an adapter is for, and Postgres rejects a negative LIMIT outright, so
  // `?limit=-1` must never reach SQL — boundedReads.convention.test.js pins
  // both halves of this clamp.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const rows = await repo.listSessions(req, {
    clientId: req.query.client_id,
    status: req.query.status,
    limit,
  });
  res.json({ data: rows });
}));

router.get('/sessions/:id', auth, STAFF, wrap(async (req, res) => {
  const session = await authz.loadSession(req, req.params.id);
  if (!session) return notFound(res, 'Session');
  const performances = await service.loadPerformances(session.id);
  res.json({ data: { ...session, performances } });
}));

router.post('/sessions', auth, STAFF, validate(schemas.sessionCreate), wrap(async (req, res) => {
  try {
    const out = await service.createSession(req, req.body);
    res.status(201).json({ data: out.session, screening_warnings: out.screening_warnings });
  } catch (err) { sendError(res, err); }
}));

router.post('/sessions/:id/seed', auth, STAFF, wrap(async (req, res) => {
  try {
    res.json({ data: await service.seedFromTemplate(req, req.params.id) });
  } catch (err) { sendError(res, err); }
}));

router.post('/sessions/:id/start', auth, STAFF, wrap(async (req, res) => {
  try {
    res.json({ data: await service.startSession(req, req.params.id) });
  } catch (err) { sendError(res, err); }
}));

router.post('/sessions/:id/complete', auth, STAFF, validate(schemas.sessionComplete),
  wrap(async (req, res) => {
    try {
      const out = await service.completeSession(req, req.params.id, req.body);
      res.json({
        data: out.session,
        summary: out.summary,
        records: out.records,
        already_complete: out.already_complete,
      });
    } catch (err) { sendError(res, err); }
  }));

router.patch('/sessions/:id', auth, STAFF, validate(schemas.sessionUpdate), wrap(async (req, res) => {
  if (!await authz.loadSession(req, req.params.id)) return notFound(res, 'Session');
  const session = await repo.updateSession(req.params.id, req.body);
  if (!session) return notFound(res, 'Nothing to update');
  res.json({ data: session });
}));

// ═══ Performances, sets and cardio ═════════════════════════════════════════

router.post('/sessions/:id/exercises', auth, STAFF, validate(schemas.performanceCreate),
  wrap(async (req, res) => {
    const session = await authz.loadSession(req, req.params.id);
    if (!session) return notFound(res, 'Session');
    const performance = await repo.createPerformance(session.id, req.body);
    res.status(201).json({ data: performance });
  }));

router.post('/performances/:id/sets', auth, STAFF, validate(schemas.setCreate), wrap(async (req, res) => {
  try {
    const out = await service.logSet(req, req.params.id, req.body);
    // 200 rather than 201 for a replay: the row already existed, and the
    // client's retry logic should be able to tell.
    res.status(out.duplicate ? 200 : 201).json({ data: out.row, duplicate: out.duplicate });
  } catch (err) { sendError(res, err); }
}));

router.post('/performances/:id/cardio', auth, STAFF, validate(schemas.cardioCreate), wrap(async (req, res) => {
  try {
    const out = await service.logCardio(req, req.params.id, req.body);
    res.status(out.duplicate ? 200 : 201).json({ data: out.row, duplicate: out.duplicate });
  } catch (err) { sendError(res, err); }
}));

router.patch('/sets/:id', auth, STAFF, validate(schemas.setUpdate), wrap(async (req, res) => {
  if (!await authz.loadSet(req, req.params.id)) return notFound(res, 'Set');
  const row = await repo.updateSet(req.params.id, req.body);
  if (!row) return notFound(res, 'Nothing to update');
  res.json({ data: row });
}));

router.delete('/sets/:id', auth, STAFF, wrap(async (req, res) => {
  if (!await authz.loadSet(req, req.params.id)) return notFound(res, 'Set');
  await repo.deleteSet(req.params.id);
  res.json({ data: { id: req.params.id, deleted: true } });
}));

router.patch('/cardio/:id', auth, STAFF, validate(schemas.cardioUpdate), wrap(async (req, res) => {
  if (!await authz.loadCardio(req, req.params.id)) return notFound(res, 'Cardio effort');
  const row = await repo.updateCardio(req.params.id, req.body);
  if (!row) return notFound(res, 'Nothing to update');
  res.json({ data: row });
}));

// ═══ Meta ══════════════════════════════════════════════════════════════════
//
// The vocabulary, served rather than duplicated.
//
// The builder needs to know which fields a prescription type uses — that is
// what makes the field set change when a trainer switches an exercise from
// SETS_REPS to TIME_DISTANCE. Hard-coding that map in the frontend would put
// a second copy of it in another repository, and the two would drift the
// first time a type gained a field. The failure is quiet in the worst way:
// the UI offers a field the API ignores, or hides one the API needs.
//
// So prescription.js stays the only definition and this endpoint publishes
// it. Static per deploy, cacheable, and cheap.
router.get('/meta', auth, STAFF, (_req, res) => {
  res.json({
    data: {
      prescription_types: prescription.PRESCRIPTION_TYPES.map((type) => ({
        type,
        required: prescription.FIELDS[type].required,
        optional: prescription.FIELDS[type].optional,
        fields: prescription.fieldsFor(type),
        logs_as: prescription.performanceKind(type),
      })),
      sections: prescription.SECTIONS,
      progression_types: require('./progression').PROGRESSION_TYPES,
      record_types: require('./records').RECORD_TYPES,
      set_types: ['WARMUP', 'WORKING', 'BACKOFF', 'DROP', 'AMRAP', 'FAILURE', 'CUSTOM'],
      cardio_types: [
        'TREADMILL', 'RUNNING', 'CYCLING', 'STATIONARY_BIKE', 'ROWING', 'ELLIPTICAL',
        'STAIRMASTER', 'STEP_MILL', 'SKI_ERG', 'SWIMMING', 'WALKING', 'SKATING',
        'PROWLER', 'JUMP_ROPE', 'HIIT', 'CIRCUIT', 'OTHER',
      ],
      units: { weight: ['kg', 'lb'], distance: ['m', 'km', 'mile'] },
    },
  });
});

// ═══ Records ═══════════════════════════════════════════════════════════════

router.get('/records', auth, STAFF, wrap(async (req, res) => {
  const clientId = req.query.client_id;
  if (!clientId) {
    return res.status(400).json({ error: { code: 'CLIENT_REQUIRED', message: 'client_id is required' } });
  }
  if (!await authz.canAccessClient(req, clientId)) return notFound(res, 'Client');
  // Live records by default; ?history=1 includes superseded ones, which is
  // the query the old boolean flags could not answer at all.
  const history = req.query.history === '1' || req.query.history === 'true';
  res.json({ data: await repo.listRecords(clientId, { history }) });
}));

module.exports = router;
