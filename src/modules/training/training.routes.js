// HTTP for the training domain, mounted at /api/training.
//
// ── Programmes and templates only ──────────────────────────────────────────
//
// This module used to carry a second half: session logging, at /sessions,
// /performances, /sets and /cardio, with its own tables behind it. That half
// is gone, and the reason is worth keeping.
//
// It was built as the destination of a migration — 167 copied the pt-os
// workout log across to this side, and the header above used to say "slice G
// repoints the old path once nothing reads it". The cutover never happened.
// Production answered the other way: /api/pt-os/workout-log kept taking every
// real session (83 in the last 30 days before removal), while every single row
// on this side — 48 sessions, 41 performances, 100 sets — carried migration
// 167's `migrated_from` provenance and not one was created natively. The
// session page that called these endpoints existed but nothing in the app
// navigated to it.
//
// (Phrased without naming those tables next to a SQL keyword on purpose:
// tenantScope.convention.test.js scans this file for table reads and does not
// strip comments, so prose can read as an unscoped query.)
//
// So the duplicate was not two systems in use; it was one system and one
// staging copy of it. workout_sessions is canonical. The copy's rows are
// preserved in the `archive` schema by migration 193.
//
// What survives here is the half production does use: programmes, templates
// and prescriptions, reached from the frontend as api.training.templates.
//
// ── What lives here and what does not ──────────────────────────────────────
//
// These handlers validate, authorise, and call. Anything spanning two tables
// and every coaching rule lives in the pure modules beside this one. A handler
// that grew SQL is a handler that will grow a second copy of a rule.
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
const repo = require('./training.repository');
const prescription = require('./prescription');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Staff who may author or log. Clients read through a separate surface. */
const STAFF = requireRole('admin', 'manager', 'trainer');

const notFound = (res, what) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `${what} not found` } });

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
      // record_types, set_types and cardio_types were published here too. All
      // three described how a session is LOGGED — the half of this module that
      // is gone — not how a template is authored, and record_types read its
      // list from records.js, which went with it. The pt-os logger owns that
      // vocabulary now, and tracks personal bests as is_pr_* flags on
      // workout_sets rather than as typed record rows.
      units: { weight: ['kg', 'lb'], distance: ['m', 'km', 'mile'] },
    },
  });
});

module.exports = router;
