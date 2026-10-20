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
const repo = require('./workout-generator.repo');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const GOALS = ['strength', 'powerlifting', 'hypertrophy', 'fat_loss', 'endurance', 'general_fitness'];
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
  if (requested) return requested;
  const g = String(clientGoal || '').toLowerCase();
  if (g === 'weight_loss') return 'fat_loss';
  if (g === 'muscle_gain') return 'hypertrophy';
  if (GOALS.includes(g)) return g;
  return 'general_fitness';
}

function normaliseExperience(level, requested) {
  if (requested) return requested;
  const v = String(level || '').toLowerCase();
  if (v === 'athlete') return 'advanced';
  if (EXPERIENCE.includes(v)) return v;
  return 'beginner';
}

router.post('/clients/:id/workout-generator/preview', auth, validate({ body: previewSchema }), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const client = await repo.findClientForOrg(req.params.id, orgId);
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const poolRows = await repo.listLibraryPool(orgId);

  const body = req.body || {};
  const draft = generateWorkout({
    client: {
      goal: normaliseGoal(client.goal, body.goal),
      experience: normaliseExperience(client.workout_experience_level, body.experience),
      avoidPatterns: body.avoidPatterns,
      avoidMuscles: body.avoidMuscles,
      equipment: body.equipment,
      maxDifficulty: body.maxDifficulty,
    },
    pool: poolRows,
    options: {
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

  // Validation before the draft leaves: every exercise in the session must be
  // one the pool supplied and none may appear in both lists. Cheap, and it
  // catches a future refactor long before a trainer notices a ghost exercise.
  const poolIds = new Set(poolRows.map((r) => r.id));
  const excludedIds = new Set(draft.excluded.map((e) => e.id));
  const problems = [];
  for (const ex of draft.mainWork) {
    if (!poolIds.has(ex.id)) problems.push(`exercise ${ex.id} is not in the library pool`);
    if (excludedIds.has(ex.id)) problems.push(`exercise ${ex.id} is both included and excluded`);
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
