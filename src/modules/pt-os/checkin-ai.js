'use strict';
// "What changed in this client's check-ins" — written by a model, from rows.
//
// ── Why this is a separate module from coach-ai.js ─────────────────────────
//
// They answer different questions from different evidence. coach-ai reads the
// whole file — assessments, PRs, goal, readiness — and says what to do about
// it. This reads one table, weekly_checkins, in order, and says what MOVED.
// A trainer opening the weekly check-in screen has already decided the
// programme; what they cannot see at a glance is that sleep has fallen for
// three weeks while adherence held.
//
// The same discipline applies, for the same reason: a model handed a thin
// context invents a trend. So every number in the prompt comes from a row that
// exists, the gaps are stated as gaps, and an unusable reply is reported as
// "nothing to show" rather than dressed up as an answer.
//
// ── Why `available: false` is not an error ─────────────────────────────────
//
// Three different situations produce nothing: too little history, the model
// being unreachable, and a reply that does not parse. None of them is a fault
// the trainer can act on, and none of them justifies inventing a summary —
// unlike coach-ai, there is no rule-based substitute for "what changed in the
// notes". So all three return a shaped, successful response carrying a reason,
// and the card declines to render. The route answers 200: the request worked,
// the answer is "nothing".

const crypto = require('crypto');

/** Below this many check-ins there is no trend to describe, only readings. */
const MIN_CHECKINS = 2;

/** How many weeks back the model is shown. Beyond this it is a report. */
const MAX_WEEKS = 12;

const SYSTEM_PROMPT = `You are a strength coach reading a client's weekly check-in history.

You will be given check-ins in chronological order, oldest first. Every figure
shown is a real recorded value. A field that is absent was NOT recorded — say
"not recorded" if it matters, and never estimate it.

Answer ONLY with JSON in this exact shape:

{"summary": "...", "notable_change": "..." | null, "suggested_action": "..." | null}

- summary: one or two sentences on the overall direction of these check-ins.
  Cite the readings you used.
- notable_change: the single largest change worth the trainer's attention, with
  the numbers and the weeks it happened between. null if nothing stands out.
- suggested_action: one concrete thing to do next week, following from the
  readings above. null if the readings do not support one.

Never mention a metric that was not recorded as though it were. Never infer a
cause the check-ins do not evidence. If these check-ins support nothing useful,
reply {"summary": "", "notable_change": null, "suggested_action": null}.`;

/**
 * The check-ins, as text the model can read.
 *
 * Oldest first, because the question is directional and a model reading
 * newest-first will describe the trend backwards. Absent fields are omitted
 * from the line rather than rendered as 0 or "-": a blank water_glasses is
 * "nobody asked", and printing it as zero is the single easiest way to get a
 * confident sentence about dehydration out of a language model.
 */
function buildFacts(checkins) {
  const rows = [...checkins].sort(
    (a, b) => String(a.week_start_date).localeCompare(String(b.week_start_date)),
  );

  const L = [`WEEKLY CHECK-INS (${rows.length}, oldest first):`, ''];

  for (const c of rows) {
    const parts = [];
    const push = (label, v, unit = '') => {
      if (v === null || v === undefined || v === '') return;
      parts.push(`${label} ${v}${unit}`);
    };
    push('weight', c.weight, 'kg');
    push('mood', c.mood);
    push('sleep', c.sleep_hours, 'h');
    push('water', c.water_glasses, ' glasses');
    push('workouts', c.workout_count);
    push('calories', c.calories_avg);
    push('adherence', c.adherence_pct, '%');
    push('stress', c.stress_level, '/10');
    push('energy', c.energy_level, '/10');
    push('soreness', c.soreness_level, '/10');

    const week = String(c.week_start_date).slice(0, 10);
    L.push(`- week of ${week}: ${parts.length ? parts.join(', ') : 'no metrics recorded'}`);

    // Notes carry the things no column has. Truncated because a trainer who
    // pastes an essay must not push the earlier weeks out of the context.
    const note = [c.trainer_notes, c.client_notes].filter(Boolean).join(' | ').trim();
    if (note) L.push(`    notes: ${note.slice(0, 400)}`);
  }

  // Say which metrics nobody is recording. This is the line that stops the
  // model assuming a blank column is a good reading.
  const tracked = ['weight', 'sleep_hours', 'adherence_pct', 'workout_count', 'stress_level', 'energy_level'];
  const never = tracked.filter((k) => rows.every((c) => c[k] === null || c[k] === undefined));
  if (never.length) {
    L.push('', `NEVER RECORDED for this client: ${never.join(', ')}. Do not comment on these.`);
  }

  return L.join('\n');
}

/** A key that changes when the check-ins change, not when the page is opened. */
function factsKey(facts) {
  return crypto.createHash('sha256').update(facts).digest('hex').slice(0, 32);
}

/**
 * Validate the model's reply against the contract the card renders.
 *
 * Returns null — meaning "unusable, show nothing" — rather than a partial
 * object. A card that renders a summary the model did not produce is the
 * failure mode this whole module is shaped to avoid.
 */
function parseInsight(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const summary = str(parsed?.summary);
  // No summary, nothing to show. The two optional fields cannot stand alone:
  // "notable_change" with no context is a number without a sentence.
  if (!summary) return null;

  return {
    summary,
    notable_change: str(parsed?.notable_change),
    suggested_action: str(parsed?.suggested_action),
  };
}

/**
 * Describe what changed across one client's check-ins.
 *
 * `chat` is injected for the same reason coach-ai injects it: prompt
 * construction and reply validation are the parts that can be wrong, and both
 * are pure. Always resolves — never throws — because every failure here is a
 * legitimate "nothing to show".
 *
 * @returns {Promise<import('./checkin-ai').CheckinInsight>}
 */
async function generateCheckinInsight({ checkins, chat }) {
  const list = Array.isArray(checkins) ? checkins.slice(0, MAX_WEEKS) : [];

  if (list.length < MIN_CHECKINS) {
    return {
      available: false,
      reason: `At least ${MIN_CHECKINS} check-ins are needed before there is a trend to describe.`,
      checkins_count: list.length,
    };
  }

  const facts = buildFacts(list);

  let res;
  try {
    res = await chat({
      intent: 'coaching',
      temperature: 0.3,       // interpretation, not creativity
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: facts },
      ],
    });
  } catch {
    // Unconfigured key, timeout, every model down. Not the trainer's problem
    // and not something to invent around.
    return {
      available: false,
      reason: 'The insight service is unavailable right now. Please try again shortly.',
      checkins_count: list.length,
    };
  }

  const parsed = parseInsight(res?.content);
  if (!parsed) {
    return {
      available: false,
      reason: 'No clear trend in these check-ins yet.',
      checkins_count: list.length,
    };
  }

  return {
    available: true,
    ...parsed,
    model: res?.model ?? null,
    facts_key: factsKey(facts),
  };
}

module.exports = {
  generateCheckinInsight, buildFacts, parseInsight, factsKey,
  SYSTEM_PROMPT, MIN_CHECKINS, MAX_WEEKS,
};
