'use strict';

// Workout generator API.
//
// POST /api/pt-os/clients/:id/workout-generator/preview
//
// Returns a complete, editable session draft for one client: warm-up, main
// work with sets/reps/load guidance, conditioning, cool-down, plus the reason
// every exercise is in it and the reason some were left out.
//
// ── Why a draft and not a save ─────────────────────────────────────────────
//
// Generation is a suggestion. This endpoint never writes: the trainer reviews
// the draft in the builder and saves it through the existing plan endpoints,
// which is also what keeps the AI-fallback path honest — if the model is
// unavailable the trainer still gets a rules-generated session from here.
//
// ── What is authoritative ──────────────────────────────────────────────────
//
// The exercise pool is read from the live library for the caller's org only
// (public built-ins plus that org's custom exercises), and the client row is
// tenant-scoped, both through workout-generator.repo.js. Restrictions
// (avoided patterns/muscles, available equipment, difficulty cap) come from
// the request body because they are the trainer's explicit decision for this
// session; recorded injuries are free text and are NOT parsed into exclusions,
// because inventing a body region from a sentence is how a generator ends up
// quietly programming through an injury.

const router = require('express').Router();
const { orgIdOf } = require('../../lib/tenant-db');
const { auth } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const { generateWorkout } = require('./workout-generator');
const powerlifting = require('./powerlifting');
const { resolveClientFacts } = require('./client-facts');
const { CANONICAL_GOALS, classifyGoal } = require('./goal-classification');
const { isTrainingBlocked } = require('../../lib/screeningGate');
const repo = require('./workout-generator.repo');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The canonical vocabulary the rest of the engine now shares. The rules
// generator only has a shape for six of them; the others fall back to general
// fitness for exercise selection while the plan keeps its real goal.
const GOALS = [...CANONICAL_GOALS];
const EXPERIENCE = ['beginner', 'intermediate', 'advanced'];
const DIFFICULTY = ['beginner', 'intermediate', 'advanced'];
const CARDIO_INTENSITIES = ['low', 'moderate', 'high', 'very-high'];
const CARDIO_METHODS = ['mhr', 'karvonen'];
const CARDIO_PROGRAMS = ['continuous-liss', 'liit-miit', 'hiit', 'fartlek'];

const previewSchema = z.object({
  goal: z.enum(GOALS).optional(),
  experience: z.enum(EXPERIENCE).optional(),
  avoidPatterns: z.array(z.string().max(80)).max(30).optional(),
  avoidMuscles: z.array(z.string().max(80)).max(30).optional(),
  equipment: z.array(z.string().max(80)).max(60).optional(),
  maxDifficulty: z.enum(DIFFICULTY).optional(),
  includeCardio: z.boolean().optional(),
  cardioMinutes: z.number().int().min(0).max(180).optional(),
  modality: z.string().max(80).optional(),
  hasVerified1RM: z.boolean().optional(),
  // The client's real training week. Both are also read from the record; the
  // request wins when the trainer is planning a different block on purpose.
  daysPerWeek: z.number().int().min(1).max(7).optional(),
  sessionMinutes: z.number().int().min(20).max(180).optional(),
  // A powerlifting block is generated whole: the preview returns every week,
  // and the caller saves them as the plan's weeks. `blockWeeks` only applies
  // to that model.
  periodization: z.enum(['powerlifting_block']).optional(),
  blockWeeks: z.number().int().min(1).max(24).optional(),
  // Additive cardio inputs. Heart-rate fields are optional: without them the
  // generator returns FITT structure but no invented target BPM.
  cardioIntensity: z.enum(CARDIO_INTENSITIES).optional(),
  cardioMethod: z.enum(CARDIO_METHODS).optional(),
  cardioFrequencyPerWeek: z.number().int().min(1).max(14).optional(),
  cardioProgramType: z.enum(CARDIO_PROGRAMS).optional(),
  age: z.number().int().min(1).max(120).optional(),
  restingHeartRate: z.number().int().positive().optional(),
  measuredMaxHeartRate: z.number().int().positive().optional(),
});

/** Map the studio's stored values onto the generator's vocabulary. */
function normaliseGoal(clientGoal, requested) {
  return classifyGoal(requested) || classifyGoal(clientGoal) || 'general_fitness';
}

function normaliseExperience(level, requested) {
  if (requested) return requested;
  const v = String(level || '').toLowerCase();
  if (v === 'athlete') return 'advanced';
  if (EXPERIENCE.includes(v)) return v;
  return 'beginner';
}

const trainingMaxSchema = z.object({
  training_max_kg: z.number().positive().max(999.99),
  source_e1rm_kg: z.number().positive().max(999.99).optional(),
  notes: z.string().max(500).optional(),
});

/**
 * The training maxes the block engine will load against, and what the logged
 * sets suggest each one could be.
 *
 * The suggestion is advisory (`applied: false` in every branch): raising a
 * max is a trainer's decision, and a block that silently re-bases itself is
 * not being steered. Competition lifts are found by name through the same
 * classifier the generator uses, so a Romanian deadlift never inherits the
 * deadlift's max.
 */
router.get('/clients/:id/training-maxes', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const client = await repo.findClientForOrg(req.params.id, orgId);
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const [stored, poolRows] = await Promise.all([
    repo.listTrainingMaxes(client.id, orgId),
    repo.listLibraryPool(orgId),
  ]);

  const competition = [];
  const seen = new Set();
  for (const ex of poolRows) {
    const lift = powerlifting.classifyLift(ex.name, ex.movementPattern);
    if (!lift || seen.has(ex.id)) continue;
    seen.add(ex.id);
    competition.push({ ...ex, lift });
  }

  const byExercise = new Map(stored.map((t) => [t.exercise_id, t]));
  const sets = await repo.listCompetitionSets(client.id, competition.map((e) => e.id));
  const bestByExercise = new Map();
  for (const set of sets) {
    const e1rm = powerlifting.estimateE1RM(set.weight_kg, set.reps);
    if (e1rm == null) continue;
    const prev = bestByExercise.get(set.exercise_id);
    if (!prev || e1rm > prev.e1rm) {
      bestByExercise.set(set.exercise_id, { e1rm, rpe: set.rpe, date: set.session_date });
    }
  }

  const experience = normaliseExperience(client.workout_experience_level, null);
  const lifts = competition.map((ex) => {
    const tm = byExercise.get(ex.id) || null;
    const best = bestByExercise.get(ex.id) || null;
    return {
      exercise_id: ex.id,
      name: ex.name,
      lift: ex.lift,
      training_max_kg: tm ? Number(tm.training_max_kg) : null,
      source: tm ? tm.source : null,
      best_e1rm_kg: best ? best.e1rm : null,
      best_e1rm_date: best ? best.date : null,
      suggestion: powerlifting.suggestTrainingMax({
        currentTrainingMaxKg: tm ? Number(tm.training_max_kg) : null,
        bestE1rmKg: best ? best.e1rm : null,
        experience,
        lastRpe: best ? best.rpe : null,
      }),
    };
  });

  res.json({
    data: {
      client: { id: client.id, name: client.name },
      experience,
      training_maxes: stored,
      lifts,
    },
  });
}));

/**
 * Set one training max. The exercise must be visible to the caller's org and
 * the client must be theirs; the table's (client, exercise) unique key makes
 * a second write an update rather than a second max.
 */
router.put('/clients/:id/training-maxes/:exerciseId',
  validate({ body: trainingMaxSchema }),
  wrap(async (req, res) => {
    const orgId = orgIdOf(req);
    const client = await repo.findClientForOrg(req.params.id, orgId);
    if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

    const exercise = await repo.findVisibleExercise(req.params.exerciseId, orgId);
    if (!exercise) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Exercise not found' } });
    }

    const row = await repo.upsertTrainingMax({
      clientId: client.id,
      organizationId: orgId,
      exerciseId: exercise.id,
      trainingMaxKg: req.body.training_max_kg,
      sourceE1rmKg: req.body.source_e1rm_kg ?? null,
      source: 'manual',
      notes: req.body.notes ?? null,
      createdBy: req.user ? req.user.id : null,
    });

    res.json({ data: row });
  }));

router.post('/clients/:id/workout-generator/preview', auth, validate({ body: previewSchema }), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const sources = await repo.loadClientFactSources(req.params.id, orgId);
  if (!sources) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const { client } = sources;
  const body = req.body || {};

  // The same resolution the AI generator uses: active goal first, then the
  // profile, then the enrolment column; experience from the profile and
  // lifestyle record too. The request is the trainer's explicit choice for
  // this session and still wins where they supplied one.
  const facts = resolveClientFacts(sources);
  const missing = [];
  if (!body.goal && !facts.facts.goal.value) missing.push('goal');
  if (!body.experience && !facts.facts.experience_level.value) missing.push('experience_level');
  if (missing.length) {
    return res.status(422).json({
      error: {
        code: 'MISSING_CLIENT_DATA',
        missing,
        message: `Record ${missing.map((f) => f.replace('_level', ' level')).join(', ')} on the client, or supply ${missing.length === 1 ? 'it' : 'them'} in this request.`,
      },
    });
  }

  // Hard safety stops apply to a draft as much as to a saved plan: a client
  // whose PAR-Q, consent or physician advice says no is not programmed for,
  // however cheap the generation is. The softer states are warnings on the
  // assignment path, not here — this endpoint writes nothing.
  if (await isTrainingBlocked(req.params.id)) {
    return res.status(403).json({
      error: { code: 'NOT_CLEARED', message: 'This client is not cleared to train. Resolve the PAR-Q, consent or physician advice before generating.' },
    });
  }

  const poolRows = await repo.listLibraryPool(orgId);

  const daysPerWeek = body.daysPerWeek
    ?? (facts.facts.training_days.value || 1);
  const sessionMinutes = body.sessionMinutes
    ?? facts.facts.session_minutes.value
    ?? null;

  // A block needs its training maxes before generation, not after: the
  // percentage on every week's row is derived from them. A client with none
  // still gets the block, prescribed by RPE, with a warning naming the lifts.
  const periodization = body.periodization === 'powerlifting_block' ? 'powerlifting_block' : null;
  const trainingMaxes = {};
  if (periodization) {
    const rows = await repo.listTrainingMaxes(req.params.id, orgId);
    for (const row of rows) trainingMaxes[row.exercise_id] = Number(row.training_max_kg);
  }

  const draft = generateWorkout({
    client: {
      goal: normaliseGoal(facts.facts.goal.value, body.goal),
      experience: normaliseExperience(facts.facts.experience_level.value, body.experience),
      avoidPatterns: body.avoidPatterns,
      avoidMuscles: body.avoidMuscles,
      equipment: body.equipment,
      maxDifficulty: body.maxDifficulty,
    },
    pool: poolRows,
    options: {
      daysPerWeek,
      sessionMinutes,
      preferredDays: facts.facts.preferred_days.value,
      periodization,
      blockWeeks: body.blockWeeks,
      trainingMaxes,
      includeCardio: body.includeCardio,
      cardioMinutes: body.cardioMinutes,
      modality: body.modality,
      hasVerified1RM: body.hasVerified1RM,
      cardioIntensity: body.cardioIntensity,
      cardioMethod: body.cardioMethod,
      cardioFrequencyPerWeek: body.cardioFrequencyPerWeek,
      cardioProgramType: body.cardioProgramType,
      age: body.age,
      restingHeartRate: body.restingHeartRate,
      measuredMaxHeartRate: body.measuredMaxHeartRate,
    },
  });

  // Validation before the draft leaves: every exercise in every session must
  // be one the pool supplied and none may appear in both lists. A block
  // returns all its weeks, so every week is checked, not only week one.
  const poolIds = new Set(poolRows.map((r) => r.id));
  const excludedIds = new Set(draft.excluded.map((e) => e.id));
  const problems = [];
  const sessionsToCheck = draft.periodization && Array.isArray(draft.periodization.weeks)
    ? draft.periodization.weeks.flatMap((week) => week.sessions || [])
    : draft.sessions;
  for (const session of sessionsToCheck) {
    for (const ex of session.mainWork) {
      if (!poolIds.has(ex.id)) problems.push(`exercise ${ex.id} is not in the library pool`);
      if (excludedIds.has(ex.id)) problems.push(`exercise ${ex.id} is both included and excluded`);
    }
  }

  res.json({
    data: {
      client: { id: client.id, name: client.name },
      draft,
      poolSize: poolRows.length,
      validation: { ok: problems.length === 0, problems },
    },
  });
}));

module.exports = router;
