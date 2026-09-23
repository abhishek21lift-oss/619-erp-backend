'use strict';
// AI Coach tool-calling — application-layer intent routing, not model-driven
// function calling.
//
// Why not native OpenAI-style function calling: this app's chat models are
// free-tier OpenRouter models (openai/gpt-oss-120b:free etc, chosen and
// swappable via env vars — see lib/ai/models.js), and function-calling
// support across free/open models is inconsistent at best. Betting a core
// feature on the model reliably emitting well-formed tool_calls would be
// fragile in a way that's hard to detect until it silently fails in
// production. Instead, each tool is triggered by pattern-matching the raw
// user message — the SAME mechanism buildClientContext() and the RAG
// knowledge base already use to inject context into the system prompt. This
// This is a continuation of an existing pattern, not a new one.
//
// Security: every tool is tenant-scoped (organization_id / trainer_id) via
// the same tenantScope()/orgParam() convention used by every other route in
// this codebase, and every tool declares which roles may run it. An
// unauthorized match is NOT silently dropped — it's reported back as a
// denial so the model can tell the user honestly, instead of answering (or
// worse, fabricating an answer) using data the requester can't see.

const pool = require('../../db/pool');
const logger = require('../logger');
const { tenantScope } = require('../tenant-db');
const { parseDateRange } = require('./dateRange');

/**
 * The organization every tool's query is filtered by: always the caller's own
 * (tenantScope() has no unfiltered case). `apply` is kept in the returned
 * shape and is always true — bind orgId even when it is null, so an account
 * with no organization gets no rows instead of the platform.
 */
function orgParam(req) {
  return tenantScope(req).orgId;
}

function orgFilters(req) {
  return { apply: true, orgId: tenantScope(req).orgId };
}

const fmtINR = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const MUSCLE_KEYWORDS = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'legs', 'quads', 'quadriceps',
  'hamstrings', 'glutes', 'calves', 'core', 'abs', 'abdominals', 'arms', 'forearms', 'traps', 'lats',
];

/* ── Person-name detection for the client-lookup tool ──────────────────────
 *
 * The first version of this only matched the literal phrasing "client named
 * X" / "member called X", which nobody actually types — "Tell me about
 * Prakhar Sharma" matched nothing, so no lookup ran and the model answered
 * that it had no information about a client who was right there in the
 * database. Matching real phrasing with ever-more regexes is a losing game,
 * so the approach is inverted: pull out anything that *could* be a name and
 * let the database decide whether it is one. A candidate that matches no
 * client simply produces no context (see `explicit` below), so a false
 * positive costs one indexed ILIKE and nothing else.
 */

// Capitalised at the start of a sentence, or just common words — a capital
// letter alone doesn't make a word someone's name.
const NAME_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'so', 'then', 'than', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'their', 'our',
  'tell', 'show', 'give', 'list', 'find', 'get', 'look', 'check', 'compare', 'explain', 'summarise', 'summarize',
  'what', 'whats', 'when', 'where', 'who', 'whos', 'why', 'how', 'hows', 'which',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'has', 'have', 'had',
  'about', 'for', 'with', 'from', 'into', 'over', 'under', 'on', 'in', 'at', 'to', 'of', 'by', 'as',
  'client', 'clients', 'member', 'members', 'trainer', 'trainers', 'studio', 'gym', 'staff',
  'please', 'thanks', 'thank', 'hi', 'hello', 'hey', 'ok', 'okay', 'yes', 'no', 'not',
  'workout', 'workouts', 'training', 'diet', 'nutrition', 'meal', 'meals', 'plan', 'plans',
  'exercise', 'exercises', 'attendance', 'revenue', 'payment', 'payments', 'dues', 'session', 'sessions',
  'progress', 'goal', 'goals', 'report', 'reports', 'profile', 'details', 'info', 'information', 'status',
  'today', 'tomorrow', 'yesterday', 'week', 'month', 'year', 'last', 'next', 'this',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  'ai', 'coach', 'pt', 'all', 'any', 'some', 'more', 'most', 'many', 'much',
  // Connector words that survive the phrase patterns above and would
  // otherwise end up inside a search pattern ("%named priya%").
  'named', 'called', 'new', 'update', 'updates', 'doing', 'know', 'like', 'need', 'want',
]);

// Only these two say outright "this is a client" — a miss on them is worth
// reporting back ("no client matching X"). Everything else is a heuristic
// guess, and a miss there stays silent rather than telling the model about a
// failed lookup for something that was never a name.
const EXPLICIT_NAME_RE = /\b(?:client|member)\s+(?:named|called)\s+([A-Za-z][A-Za-z\s.'’-]{1,40})/i;

// Phrasings that strongly imply a person follows, but could equally be a
// topic ("tell me about protein timing") — hence heuristic, not explicit.
const IMPLICIT_NAME_RES = [
  /\btell me about\s+([A-Za-z][A-Za-z\s.'’-]{1,40})/i,
  /\bhow(?:'s|’s| is)\s+([A-Za-z][A-Za-z\s.'’-]{1,40})\s+doing\b/i,
  /\b(?:profile|details|info|information|status|progress|attendance|balance|dues)\s+(?:for|of|on)\s+([A-Za-z][A-Za-z\s.'’-]{1,40})/i,
  /\b(?:look up|lookup|search for|find)\s+([A-Za-z][A-Za-z\s.'’-]{1,40})/i,
];

function cleanCandidate(raw) {
  let s = String(raw || '').trim().replace(/[?.!,;:]+$/, '');
  // "prakhar sharma and his plan" → "prakhar sharma"
  s = s.split(/\s+(?:and|or|for|with|in|on|at|to|from|about|please|regarding|vs)\s+/i)[0];
  s = s.replace(/['’]s$/i, '');
  const words = s.split(/\s+/).filter(Boolean).slice(0, 4)
    .filter((w) => !NAME_STOPWORDS.has(w.toLowerCase().replace(/[^a-z'’-]/gi, '')));
  return words.join(' ').trim();
}

/**
 * Returns { candidates: string[], explicit: boolean } — names worth looking
 * up, and whether the user unambiguously called one a client/member.
 */
function extractNameCandidates(msg) {
  const text = String(msg || '');
  const candidates = [];
  let explicit = false;

  const exp = text.match(EXPLICIT_NAME_RE);
  if (exp) {
    const c = cleanCandidate(exp[1]);
    if (c.length >= 2) { candidates.push(c); explicit = true; }
  }

  for (const re of IMPLICIT_NAME_RES) {
    const m = text.match(re);
    if (m) {
      const c = cleanCandidate(m[1]);
      if (c.length >= 2) candidates.push(c);
    }
  }

  // Bare capitalised runs anywhere in the message ("Any update on Prakhar
  // Sharma?"), which the phrasing patterns above would miss entirely.
  const capRuns = text.match(/\b[A-Z][a-z'’-]{1,}(?:\s+[A-Z][a-z'’-]{1,})*/g) || [];
  for (const run of capRuns) {
    const c = cleanCandidate(run);
    if (c.length >= 3) candidates.push(c);
  }

  // Dedup case-insensitively, longest first (a full name beats its first
  // name), and cap the count so one message can't fan out into many queries.
  const seen = new Set();
  const unique = candidates
    .sort((a, b) => b.length - a.length)
    .filter((c) => {
      const k = c.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 3);

  return { candidates: unique, explicit };
}

const TOOLS = [
  /* ── Client stats ── */
  {
    name: 'client_stats',
    label: 'Client Stats',
    roles: ['trainer'],
    test: (msg) => /\b(how many|count of|number of)\b.*\b(client|clients|member|members)\b|\b(active|expired|expiring|frozen)\s+(clients?|members?)\b/i.test(msg),
    async run(req) {
      const org = orgFilters(req);
      const params = [];
      let p = 1;
      const conds = ['deleted_at IS NULL'];
      // Bound even when orgId is null: `organization_id = NULL` is never true,
      // so an org-less tenant user gets no rows instead of the whole platform.
      conds.push(`organization_id = $${p++}`); params.push(org.orgId);
      const { rows } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'active') AS active,
           COUNT(*) FILTER (WHERE status IN ('expired','inactive')) AS inactive,
           COUNT(*) FILTER (WHERE status = 'frozen') AS frozen,
           COUNT(*) FILTER (WHERE status = 'active' AND pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days') AS expiring_soon,
           COUNT(*) AS total
         FROM pt_clients WHERE ${conds.join(' AND ')}`,
        params
      );
      return rows[0];
    },
    format: (r) => `Client stats: ${r.total} total, ${r.active} active, ${r.inactive} inactive/expired, ${r.frozen} frozen, ${r.expiring_soon} expiring within 7 days.`,
  },

  /* ── Look up one specific client by name ─────────────────────────────── */
  {
    name: 'find_client',
    label: 'Client Lookup',
    roles: ['trainer'],
    test: (msg) => extractNameCandidates(msg).candidates.length > 0,
    extract: (msg) => extractNameCandidates(msg),
    async run(req, extracted) {
      const { candidates } = extracted;
      const org = orgFilters(req);

      const params = candidates.map((c) => `%${c}%`);
      const nameClause = candidates.map((_, i) => `name ILIKE $${i + 1}`).join(' OR ');
      let p = candidates.length + 1;
      const conds = ['deleted_at IS NULL', `(${nameClause})`];
      conds.push(`organization_id = $${p++}`); params.push(org.orgId);

      const { rows } = await pool.query(
        `SELECT name, status, mobile, package_type, trainer_name, balance_amount,
                paid_amount, final_amount, pt_start_date, pt_end_date, goal
         FROM pt_clients WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 3`,
        params
      );
      return rows;
    },
    format: (rows, extracted) => {
      const { candidates, explicit } = extracted;
      if (!rows.length) {
        // Only report a miss when the user actually said "client named X".
        // A heuristic guess that found nothing was probably never a name
        // ("Tell me about Progressive Overload") — staying silent lets the
        // model answer the question normally instead of being told about a
        // failed client lookup it should then explain away.
        return explicit
          ? `No client matching "${candidates[0]}" was found in this studio's records.`
          : '';
      }
      return rows.map((c) => [
        `${c.name} — status: ${c.status}`,
        `plan: ${c.package_type || 'n/a'}`,
        `trainer: ${c.trainer_name || 'unassigned'}`,
        c.goal ? `goal: ${c.goal}` : null,
        `fee: ${fmtINR(c.final_amount)}, paid: ${fmtINR(c.paid_amount)}, balance due: ${fmtINR(c.balance_amount)}`,
        `PT period: ${c.pt_start_date ? new Date(c.pt_start_date).toLocaleDateString('en-IN') : 'n/a'} → ${c.pt_end_date ? new Date(c.pt_end_date).toLocaleDateString('en-IN') : 'n/a'}`,
        c.mobile ? `mobile: ${c.mobile}` : null,
      ].filter(Boolean).join(', ')).join('\n');
    },
  },

  /* ── Attendance summary ─────────────────────────────────────────────── */
  {
    name: 'attendance_summary',
    label: 'Attendance',
    roles: ['trainer'],
    test: (msg) => /\b(attendance|check-?in|checked in|present|absent)\b/i.test(msg),
    async run(req, _match, message) {
      const { from, to, label } = parseDateRange(message);
      const org = orgFilters(req);
      const params = [from, to];
      let p = 3;
      let orgFilter = '';
      orgFilter = `AND a.organization_id = $${p++} `; params.push(org.orgId);

      const { rows } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'present') AS present,
           COUNT(*) FILTER (WHERE status = 'absent') AS absent,
           COUNT(*) FILTER (WHERE status = 'late') AS late,
           COUNT(DISTINCT ref_id) AS unique_clients,
           COUNT(*) AS total
         FROM attendance_logs a
         WHERE a.ref_type = 'client' AND a.date BETWEEN $1::date AND $2::date ${orgFilter}`,
        params
      );
      return { ...rows[0], label };
    },
    format: (r) => `Attendance (${r.label}): ${r.total} check-ins recorded, ${r.unique_clients} unique clients, ${r.present} present, ${r.absent} absent, ${r.late} late.`,
  },

  /* ── Exercise library search ─────────────────────────────────────────── */
  {
    name: 'search_exercises',
    label: 'Exercise Search',
    roles: ['trainer'],
    test: (msg) => /\bexercises?\b.*\b(for|targeting|that work|to (train|hit))\b|\bworkout\s+(move|exercise)s?\b/i.test(msg)
      && MUSCLE_KEYWORDS.some((k) => msg.toLowerCase().includes(k)),
    extract: (msg) => {
      const lower = msg.toLowerCase();
      return MUSCLE_KEYWORDS.find((k) => lower.includes(k)) || null;
    },
    async run(req, muscle) {
      // The same visibility rule as routes/exercises.js: the built-in library
      // plus this studio's own custom exercises, and nothing of any other
      // studio's.
      const org = orgParam(req);
      if (!org) return [];
      const { rows } = await pool.query(
        `SELECT e.name, e.muscle_group, e.body_part, e.equipment, e.difficulty
         FROM exercises e
         WHERE e.deleted_at IS NULL AND e.archived_at IS NULL
           AND (e.organization_id IS NULL OR e.organization_id = $2::uuid)
           AND (e.muscle_group ILIKE $1 OR e.body_part ILIKE $1 OR e.target_muscle ILIKE $1)
         ORDER BY e.name LIMIT 8`,
        [`%${muscle}%`, org]
      );
      return rows;
    },
    format: (rows, muscle) => {
      if (!rows.length) return `No exercises found in the library for "${muscle}".`;
      return `Exercises for ${muscle}:\n` + rows.map((e) => `- ${e.name} (${e.equipment || 'no equipment listed'}, ${e.difficulty || 'difficulty n/a'})`).join('\n');
    },
  },

  /* ── Revenue summary (financial data — the studio's trainer) ───────────── */
  {
    name: 'revenue_summary',
    label: 'Revenue',
    roles: ['trainer'],
    test: (msg) => /\b(revenue|earnings|income|collections?)\b/i.test(msg),
    async run(req, _match, message) {
      const { from, to, label } = parseDateRange(message);
      const org = orgFilters(req);
      const params = [from, to];
      let orgFilter = '';
      orgFilter = 'AND organization_id = $3'; params.push(org.orgId);
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_revenue, COUNT(*) AS total_payments
         FROM pt_payments WHERE date BETWEEN $1 AND $2 AND deleted_at IS NULL ${orgFilter}`,
        params
      );
      return { ...rows[0], label };
    },
    format: (r) => `Revenue (${r.label}): ${fmtINR(r.total_revenue)} across ${r.total_payments} payment${r.total_payments === '1' ? '' : 's'}.`,
  },

  /* ── Outstanding dues ─────────────────────────────────────────────────── */
  {
    name: 'dues_summary',
    label: 'Outstanding Dues',
    roles: ['trainer'],
    test: (msg) => /\b(outstanding|pending)\s+dues?\b|\bwho owes\b|\bunpaid\b|\bbalance\s+(due|owed)\b/i.test(msg),
    async run(req) {
      const org = orgFilters(req);
      const params = [];
      let orgFilter = '';
      orgFilter = 'AND organization_id = $1'; params.push(org.orgId);
      const [{ rows: totals }, { rows }] = await Promise.all([
        pool.query(
          `SELECT COALESCE(SUM(balance_amount), 0) AS total,
                  COUNT(*) AS debtor_count
             FROM pt_clients
            WHERE deleted_at IS NULL AND balance_amount > 0 ${orgFilter}`,
          params
        ),
        pool.query(
          `SELECT name, balance_amount FROM pt_clients
            WHERE deleted_at IS NULL AND balance_amount > 0 ${orgFilter}
            ORDER BY balance_amount DESC LIMIT 10`,
          params
        ),
      ]);
      return {
        rows,
        total: Number(totals[0]?.total || 0),
        debtor_count: Number(totals[0]?.debtor_count || 0),
      };
    },
    format: ({ rows, total, debtor_count }) => {
      if (!rows.length) return 'No clients currently have an outstanding balance.';
      const top = rows.map((r) => `${r.name}: ${fmtINR(r.balance_amount)}`).join(', ');
      const n = debtor_count || rows.length;
      return `Outstanding dues: ${fmtINR(total)} total across ${n} client${n === 1 ? '' : 's'} (top: ${top}).`;
    },
  },

];

/**
 * Pattern-matches `message` against every tool, runs the ones that match
 * (role-permitted ones for real, unauthorized ones as a recorded denial so
 * the model can say so rather than guess), and returns a summary the chat
 * route can inject into the system prompt and report to the client.
 *
 * Capped at 2 tools per message — a chat question realistically touches at
 * most one or two of these topics, and running more adds latency for no
 * real benefit.
 */
async function runTools(req, message) {
  const matched = TOOLS.filter((t) => t.test(message)).slice(0, 2);
  if (!matched.length) return { toolNames: [], contextText: '' };

  const toolNames = [];
  const contextParts = [];

  for (const tool of matched) {
    // Fail closed: a tool that names no roles is authorised for nobody.
    const authorized = Array.isArray(tool.roles) && tool.roles.includes(req.user.role);
    if (!authorized) {
      contextParts.push(`[${tool.label}] The current user's role ("${req.user.role}") is not permitted to view this data — say so plainly rather than answering.`);
      toolNames.push(tool.label);
      continue;
    }
    try {
      const match = tool.extract ? tool.extract(message) : null;
      if (tool.extract && !match) continue; // pattern matched but couldn't extract a usable argument
      const result = await tool.run(req, match, message);
      const text = tool.format(result, match);
      // An empty format() means the tool deliberately found nothing worth
      // saying (e.g. a guessed name that matched no client). Injecting an
      // empty "[Client Lookup]" heading, or claiming the tool was consulted
      // in the UI, would both be noise.
      if (!text) continue;
      contextParts.push(`[${tool.label}] ${text}`);
      toolNames.push(tool.label);
    } catch (err) {
      // Reported to the model, not just to the log.
      //
      // This used to log and move on, so a tool that threw looked exactly
      // like a tool that was never triggered: the model got no line, no
      // denial, nothing — and answered the question anyway, from whatever it
      // could infer. For "how many active clients do I have?" that is a
      // fabricated number presented as this studio's data.
      //
      // The honest-denial shape directly above already exists for the
      // authorization case; a failure is the same situation with a different
      // cause, so it takes the same shape rather than a new one.
      logger.warn({ tool: tool.name, err: err.message }, 'ai_tool_run_failed');
      contextParts.push(`[${tool.label}] This lookup failed just now, so no figures were retrieved. Tell the user the data could not be read rather than answering from memory or estimating.`);
      toolNames.push(tool.label);
    }
  }

  return { toolNames, contextText: contextParts.join('\n\n') };
}

module.exports = { runTools, TOOLS };
