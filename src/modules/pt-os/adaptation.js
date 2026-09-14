'use strict';

/**
 * What the last session says to do with the next one, decided by rule.
 *
 * ── Why this is not left to the model ──────────────────────────────────────
 *
 * `mode=adapt` changed what the generator was TOLD. It put the client's week
 * and plan name at the top of the prompt and asked for a continuation rather
 * than a new block, and that is a real improvement over writing week 1 over a
 * client in week 4. It is also, in the end, an instruction — and an
 * instruction is not a decision. Nothing looked at what the client had
 * actually lifted and said "this lift earned an increase and that one did
 * not". The model was free to progress everything, progress nothing, or
 * progress the one movement the client had failed twice.
 *
 * So the decision is made here, from logged sets against the prescription that
 * produced them, before the model sees anything. The model is handed the
 * verdicts and the numbers behind each one and asked to WRITE them, not to
 * reach them. A trainer can check every line, because every line carries the
 * arithmetic it came from.
 *
 * ── The rules, stated ──────────────────────────────────────────────────────
 *
 * For each exercise the next session prescribes:
 *
 *   REGRESS      the top set has fallen in each of the last two sessions.
 *                Three data points, because two make a line out of noise.
 *   HOLD         the prescription was not met — sets missed, or a set short
 *                of the bottom of the rep range.
 *   PROGRESS     every prescribed set was completed AND every one of them
 *                reached the TOP of the prescribed rep range.
 *   INSUFFICIENT the studio has no logged evidence for this exercise, or the
 *                evidence it has cannot be compared with the prescription.
 *
 * INSUFFICIENT is the default and the point of the whole module. "We do not
 * know" is a verdict here, not a gap to be filled with the most plausible of
 * the other three — and it is by far the most common one on this studio's
 * data, where 29 of 34 clients have no attributable session log at all.
 *
 * Nothing here writes, nothing here changes a plan, and nothing here reaches
 * the safety screen. A verdict is evidence offered to the generation and to
 * the trainer; the trainer remains the gate.
 */

const { normaliseName } = require('./plan-critic');

/**
 * Sessions needed before a fall counts as a regression.
 *
 * Three: the two that fell, and the one they fell from. A client who has one
 * bad Tuesday has had one bad Tuesday, and dropping their load for it would
 * make the engine chase noise.
 */
const MIN_SESSIONS_FOR_REGRESSION = 3;

const DECISION = Object.freeze({
  PROGRESS: 'progress',
  HOLD: 'hold',
  REGRESS: 'regress',
  INSUFFICIENT: 'insufficient_evidence',
});

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const isoDay = (v) => {
  if (!v) return null;
  const s = typeof v === 'string' ? v : v.toISOString?.();
  return s ? String(s).slice(0, 10) : null;
};

/**
 * A rep prescription as a { min, max } range.
 *
 * Accepts 10, "10", "8-10", "8 to 10", "8–10" (en dash — the builder's own
 * input produces it on a Mac). Anything else, AMRAP included, returns null:
 * "as many as possible" has no top of range to have reached, so an exercise
 * prescribed that way is judged on completed sets alone rather than against a
 * number this function invented.
 */
function repRange(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    return Number.isFinite(v) && v > 0 ? { min: v, max: v } : null;
  }
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*(?:-|–|—|to)\s*(\d+)$/i);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    return lo > 0 && hi >= lo ? { min: lo, max: hi } : null;
  }
  const single = s.match(/^(\d+)$/);
  if (single) {
    const n = Number(single[1]);
    return n > 0 ? { min: n, max: n } : null;
  }
  return null;
}

/**
 * Logged sets grouped into sessions for one exercise, newest session first.
 *
 * Completed sets only. An uncompleted set is a set the client did not do, and
 * counting it as performance is how an engine concludes somebody is
 * progressing on a lift they have been walking away from.
 */
function sessionsOf(sets = []) {
  const byDay = new Map();
  for (const s of sets) {
    if (s?.completed !== true) continue;
    const day = isoDay(s.session_date);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([on, rows]) => ({
      on,
      sets: rows,
      completed_sets: rows.length,
      // The heaviest set of the day. Volume would move with how many sets the
      // trainer happened to write, so it cannot separate "lifting less" from
      // "prescribed less"; the top set moves only when the client does.
      top_weight_kg: rows.reduce((max, r) => {
        const w = num(r.weight_kg);
        return w !== null && (max === null || w > max) ? w : max;
      }, null),
      min_reps: rows.reduce((min, r) => {
        const n = num(r.reps);
        return n !== null && (min === null || n < min) ? n : min;
      }, null),
    }));
}

/** Strictly falling across the three most recent sessions. */
function isRegressing(history) {
  if (history.length < MIN_SESSIONS_FOR_REGRESSION) return false;
  const [a, b, c] = history; // newest, previous, the one before that
  const w = [a.top_weight_kg, b.top_weight_kg, c.top_weight_kg];
  if (w.some((x) => x === null)) return false;
  return w[0] < w[1] && w[1] < w[2];
}

/**
 * One verdict per prescribed exercise.
 *
 * @param {object}   input
 * @param {object[]} input.prescribed  the next session's exercises, from
 *        next-session.js: name, sets, reps, target_weight.
 * @param {object[]} input.sets        every logged set in the window, with
 *        exercise_name, weight_kg, reps, completed and session_date. The same
 *        rows the training history is built from, matched by normalised name.
 */
function adaptationDecisions({ prescribed = [], sets = [] } = {}) {
  const byName = new Map();
  for (const s of sets) {
    const key = normaliseName(s?.exercise_name || '');
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(s);
  }

  const decisions = (prescribed || []).map((ex) => {
    const name = ex?.name ?? null;
    const key = name ? normaliseName(name) : '';
    const history = key ? sessionsOf(byName.get(key) || []) : [];
    return decide(ex, history);
  });

  const count = (d) => decisions.filter((x) => x.decision === d).length;
  return {
    decisions,
    counts: {
      progress: count(DECISION.PROGRESS),
      hold: count(DECISION.HOLD),
      regress: count(DECISION.REGRESS),
      insufficient_evidence: count(DECISION.INSUFFICIENT),
      total: decisions.length,
    },
    // True when not one prescribed exercise has evidence behind it. The
    // generator says so out loud rather than writing a progression that looks
    // like it was derived from something.
    evidence_free: decisions.length > 0
      && decisions.every((d) => d.decision === DECISION.INSUFFICIENT),
  };
}

function decide(ex, history) {
  const base = {
    exercise: ex?.name ?? null,
    prescribed: {
      sets: num(ex?.sets),
      reps: ex?.reps ?? null,
      target_weight: num(ex?.target_weight),
    },
    sessions_logged: history.length,
    last_performed_on: history[0]?.on ?? null,
  };

  if (!history.length) {
    return {
      ...base,
      decision: DECISION.INSUFFICIENT,
      because: base.exercise
        ? `No completed set of ${base.exercise} has been logged in the window. There is no evidence to progress or hold from.`
        : 'The prescription names no exercise, so nothing can be matched to the log.',
    };
  }

  // Falling first. A regression is the one verdict that must not be
  // overridden by a prescription that happens to have been met on the way
  // down — a client who completed every set of 60 kg after completing every
  // set of 70 kg has not earned a progression.
  if (isRegressing(history)) {
    const [a, b, c] = history;
    return {
      ...base,
      decision: DECISION.REGRESS,
      because: `Top set has fallen in each of the last two sessions: ${c.top_weight_kg} kg on ${c.on}, ${b.top_weight_kg} kg on ${b.on}, ${a.top_weight_kg} kg on ${a.on}.`,
    };
  }

  const last = history[0];
  const wantSets = num(ex?.sets);
  const range = repRange(ex?.reps);

  if (wantSets !== null && last.completed_sets < wantSets) {
    return {
      ...base,
      decision: DECISION.HOLD,
      because: `${last.completed_sets} of ${wantSets} prescribed sets were completed on ${last.on}. Hold the prescription until it is completed as written.`,
    };
  }

  if (range === null) {
    // No comparable rep target — AMRAP, a free-text prescription, or nothing
    // written at all. Sets alone cannot separate "met it" from "beat it", so
    // the honest verdict is that we cannot tell rather than the flattering one.
    return {
      ...base,
      decision: DECISION.INSUFFICIENT,
      because: ex?.reps
        ? `The prescription reads "${ex.reps}", which has no rep target to compare the ${last.completed_sets} completed sets on ${last.on} against.`
        : `No rep prescription is recorded for this exercise, so the ${last.completed_sets} completed sets on ${last.on} cannot be judged against it.`,
    };
  }

  if (last.min_reps === null) {
    return {
      ...base,
      decision: DECISION.INSUFFICIENT,
      because: `Sets were logged on ${last.on} with no reps recorded, so they cannot be compared with the prescribed ${range.min}${range.max > range.min ? `-${range.max}` : ''}.`,
    };
  }

  if (last.min_reps < range.min) {
    return {
      ...base,
      decision: DECISION.HOLD,
      because: `Lowest set on ${last.on} was ${last.min_reps} reps against a prescribed ${range.min}${range.max > range.min ? `-${range.max}` : ''}. Hold until the bottom of the range is met on every set.`,
    };
  }

  if (last.min_reps >= range.max) {
    return {
      ...base,
      decision: DECISION.PROGRESS,
      because: `Every prescribed set was completed on ${last.on} at ${last.min_reps} reps or more, reaching the top of the prescribed ${range.min}${range.max > range.min ? `-${range.max}` : ''}.`
        + (last.top_weight_kg !== null ? ` Top set ${last.top_weight_kg} kg.` : ''),
    };
  }

  return {
    ...base,
    decision: DECISION.HOLD,
    because: `Lowest set on ${last.on} was ${last.min_reps} reps, inside the prescribed ${range.min}-${range.max} but not at the top of it. Hold until the top of the range is reached on every set.`,
  };
}

/**
 * The verdicts, as the model is allowed to read them.
 *
 * The instruction under the list is the load-bearing half: without it a model
 * reads four verdicts as four suggestions and writes whatever progression it
 * would have written anyway.
 */
function describeAdaptation(result) {
  if (!result || !result.decisions.length) return '';
  const L = ['WHAT THE EVIDENCE SAYS TO DO WITH EACH LIFT (decided by rule, from logged sets — do not overrule it):'];
  for (const d of result.decisions) {
    L.push(`- ${d.exercise || 'Unnamed exercise'}: ${d.decision.toUpperCase().replace(/_/g, ' ')} — ${d.because}`);
  }
  L.push(
    '',
    'Write these verdicts into the programme. PROGRESS means increase load, reps or sets on that exercise and say by how much. HOLD means keep the prescription as it is and say why. REGRESS means reduce the load and say so plainly.',
    'INSUFFICIENT EVIDENCE means this studio has no logged proof either way. Keep the prescription, do NOT describe the client as progressing, plateaued or regressing on it, and do not invent a trend to justify a change.',
  );
  if (result.evidence_free) {
    L.push(
      '',
      'NONE of the prescribed exercises has logged evidence behind it. Say so in the programme, and base any change on the client facts and the safety screen rather than on a training history that does not exist.',
    );
  }
  return L.join('\n');
}

module.exports = {
  adaptationDecisions, describeAdaptation, DECISION,
  MIN_SESSIONS_FOR_REGRESSION,
  // Exported for the tests that pin the parsing and grouping directly.
  repRange, sessionsOf, isRegressing,
};
