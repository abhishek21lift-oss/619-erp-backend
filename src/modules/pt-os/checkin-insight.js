// A short, advisory read of a client's recent weekly check-ins.
//
// Same discipline as coach-ai.js, applied to a much smaller set of facts:
// the model only ever sees check-in rows that exist, is told plainly when a
// field on a given check-in is empty, and its reply is validated rather than
// trusted. Nothing this produces is written to any client record — it is a
// card a trainer reads and dismisses, never an input to anything else.
//
// Also mirrors coach-ai.js's testability shape: `chat` is injected, so the
// prompt construction and the response validation — the parts that can be
// wrong — are testable without an API key or a network call.

/** Renders one check-in row as a line the model can read, naming gaps. */
function checkinLine(c) {
  const date = c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : 'unknown date';
  const parts = [
    c.weight != null ? `weight ${c.weight}kg` : 'weight not logged',
    c.mood ? `mood ${c.mood}` : 'mood not logged',
    c.sleep_hours != null ? `sleep ${c.sleep_hours}h` : 'sleep not logged',
    c.water_glasses != null ? `water ${c.water_glasses} glasses` : 'water not logged',
  ];
  const notes = typeof c.client_notes === 'string' && c.client_notes.trim() ? `notes: "${c.client_notes.trim()}"` : null;
  return `- ${date}: ${parts.join(', ')}${notes ? `, ${notes}` : ''}`;
}

/**
 * The facts, as text the model can read. Oldest first, matching the shape
 * every other generator in this codebase feeds the model.
 */
function buildFacts({ client, checkins = [] }) {
  const L = [];
  L.push(`CLIENT: ${client?.name ?? 'Unknown'}`);
  L.push('', `RECENT WEEKLY CHECK-INS (oldest to newest, ${checkins.length} total):`);
  for (const c of checkins) L.push(checkinLine(c));
  return L.join('\n');
}

const SYSTEM_PROMPT = `You are reviewing a personal training client's recent weekly check-ins for their trainer.

You will be given ONLY the check-in rows that exist, in order. Some fields on a check-in may be marked "not logged" — you must not invent a value for those or assume they are fine.

Rules, in order of importance:
1. Never state a number or fact that is not in the check-ins you were given.
2. Summarise what actually changed across the check-ins — do not restate every entry.
3. Call out at most ONE thing that most deserves the trainer's attention. If nothing stands out, say so plainly rather than manufacturing a concern.
4. Suggest one concrete, specific action the trainer could take or ask about — or none, if there is nothing useful to suggest.
5. You are writing for the trainer, not the client. No medical advice or diagnosis.

Reply with JSON only, no prose around it:
{"summary":"1-2 sentences on what changed","notable_change":"the one thing most worth attention, or null","suggested_action":"one concrete next step, or null"}`;

/** Parse the model's reply, keeping only what obeys the contract. */
function parseInsight(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }

  const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
  // A reply with no summary at all is not a usable insight — the whole point
  // is "what changed", and an empty summary means the model said nothing.
  if (!summary) return null;

  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    summary,
    notable_change: clean(parsed?.notable_change),
    suggested_action: clean(parsed?.suggested_action),
  };
}

/**
 * Generate a check-in insight for one client.
 *
 * No fallback content, unlike generateCoach: there is no rule-based
 * substitute for "what changed in this client's notes", so when the model
 * is unavailable or replies with nothing usable, the card simply does not
 * appear — `available: false` — rather than showing something invented.
 */
async function generateCheckinInsight({ client, checkins = [], chat }) {
  const facts = buildFacts({ client, checkins });

  try {
    const res = await chat({
      intent: 'checkin',
      temperature: 0.4,
      max_tokens: 400,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: facts },
      ],
    });
    const insight = parseInsight(res?.content);
    if (!insight) return { available: false, reason: 'unparseable_response' };
    return { available: true, ...insight, model: res?.model ?? null };
  } catch {
    return { available: false, reason: 'ai_unavailable' };
  }
}

module.exports = { generateCheckinInsight, buildFacts, parseInsight, SYSTEM_PROMPT };
