'use strict';

// Strict validation at the AI → database boundary.
//
// `plan-materialise` is deliberately forgiving: it coerces numbers, drops
// unknown days and reports what it could not resolve. That is right while the
// trainer is still reviewing a proposal. It is not right at the moment the
// proposal becomes the client's programme, because a malformed object would
// otherwise be saved as a plan that silently holds fewer days than it claims.
//
// This module answers one question before persistence: is this proposal
// structurally a workout at all? Coaching quality, volume and safety belong to
// `plan-critic`; shape belongs here. Every error carries the path it failed at
// so the trainer sees which day to fix instead of "invalid plan".

const PROGRESSION_TYPES = new Set(['none', 'weight', 'reps', 'rpe']);
const MAX_WEEKS = 52;
const MAX_DAYS = 7;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate a generated plan before it is materialised or saved.
 *
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
function validateProposedPlan(plan) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  if (!isObject(plan)) {
    return { ok: false, errors: [{ path: '', message: 'plan must be an object' }] };
  }

  if (plan.weeks !== undefined && (!finite(plan.weeks) || plan.weeks < 1 || plan.weeks > MAX_WEEKS)) {
    push('weeks', `must be a whole number between 1 and ${MAX_WEEKS}`);
  }
  if (plan.days_per_week !== undefined
    && (!finite(plan.days_per_week) || plan.days_per_week < 1 || plan.days_per_week > MAX_DAYS)) {
    push('days_per_week', `must be a whole number between 1 and ${MAX_DAYS}`);
  }

  if (plan.progression !== undefined) {
    if (!isObject(plan.progression)) {
      push('progression', 'must be an object');
    } else {
      const type = text(plan.progression.type) || 'none';
      if (!PROGRESSION_TYPES.has(type)) {
        push('progression.type', `must be one of: ${[...PROGRESSION_TYPES].join(', ')}`);
      }
      if (type !== 'none' && (!finite(plan.progression.amount) || plan.progression.amount <= 0)) {
        push('progression.amount', 'must be a positive number when a progression type is set');
      }
      if (plan.progression.every_weeks !== undefined
        && (!finite(plan.progression.every_weeks) || plan.progression.every_weeks < 1)) {
        push('progression.every_weeks', 'must be a number of at least 1');
      }
    }
  }

  const schedule = plan.weekly_schedule;
  if (!isObject(schedule) || Object.keys(schedule).length === 0) {
    push('weekly_schedule', 'must name at least one training day');
    return { ok: false, errors };
  }

  let exerciseCount = 0;
  for (const [dayName, day] of Object.entries(schedule)) {
    const path = `weekly_schedule.${dayName}`;
    if (!isObject(day)) {
      push(path, 'must be an object');
      continue;
    }
    if (day.estimated_minutes !== undefined && (!finite(day.estimated_minutes) || day.estimated_minutes <= 0)) {
      push(`${path}.estimated_minutes`, 'must be a positive number of minutes');
    }
    const exercises = day.exercises;
    if (!Array.isArray(exercises) || exercises.length === 0) {
      push(`${path}.exercises`, 'must be a non-empty array');
      continue;
    }
    exercises.forEach((ex, i) => {
      const exPath = `${path}.exercises[${i}]`;
      if (!isObject(ex)) {
        push(exPath, 'must be an object');
        return;
      }
      if (!text(ex.name)) {
        push(`${exPath}.name`, 'must name an exercise');
        return;
      }
      exerciseCount += 1;
      if (ex.sets !== undefined && (!finite(ex.sets) || ex.sets < 0)) {
        push(`${exPath}.sets`, 'must be zero or more');
      }
      if (ex.rest_seconds !== undefined && (!finite(ex.rest_seconds) || ex.rest_seconds < 0)) {
        push(`${exPath}.rest_seconds`, 'must be zero or more seconds');
      }
      if (ex.duration_seconds !== undefined && (!finite(ex.duration_seconds) || ex.duration_seconds < 0)) {
        push(`${exPath}.duration_seconds`, 'must be zero or more seconds');
      }
      if (ex.distance !== undefined && (!finite(ex.distance) || ex.distance < 0)) {
        push(`${exPath}.distance`, 'must be zero or more');
      }
    });
  }

  if (exerciseCount === 0 && errors.length === 0) {
    push('weekly_schedule', 'must prescribe at least one exercise');
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateProposedPlan };
