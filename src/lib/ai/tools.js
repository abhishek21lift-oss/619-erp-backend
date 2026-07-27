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

function orgParam(req) {
  const scope = tenantScope(req);
  return scope.applyFilter ? scope.orgId : null;
}

const fmtINR = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const MUSCLE_KEYWORDS = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'legs', 'quads', 'quadriceps',
  'hamstrings', 'glutes', 'calves', 'core', 'abs', 'abdominals', 'arms', 'forearms', 'traps', 'lats',
];

const TOOLS = [
  /* ── Client stats (any staff role; trainers see only their own roster) ── */
  {
    name: 'client_stats',
    label: 'Client Stats',
    roles: ['admin', 'manager', 'trainer', 'reception'],
    test: (msg) => /\b(how many|count of|number of)\b.*\b(client|clients|member|members)\b|\b(active|expired|expiring|frozen)\s+(clients?|members?)\b/i.test(msg),
    async run(req) {
      const org = orgParam(req);
      const trainerId = req.user.role === 'trainer' ? req.user.trainer_id : null;
      const params = [];
      let p = 1;
      const conds = ['deleted_at IS NULL'];
      if (org) { conds.push(`organization_id = $${p++}`); params.push(org); }
      if (trainerId) { conds.push(`trainer_id = $${p++}`); params.push(trainerId); }
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
    roles: ['admin', 'manager', 'trainer', 'reception'],
    test: (msg) => /\b(?:client|member)\s+(?:named|called)\s+[a-z]/i.test(msg),
    extract: (msg) => {
      const m = msg.match(/\b(?:client|member)\s+(?:named|called)\s+([a-z][a-z\s.'-]{1,40})/i);
      return m ? m[1].trim().replace(/[?.!,]+$/, '') : null;
    },
    async run(req, name) {
      const org = orgParam(req);
      const trainerId = req.user.role === 'trainer' ? req.user.trainer_id : null;
      const params = [`%${name}%`];
      let p = 2;
      const conds = ['deleted_at IS NULL', 'name ILIKE $1'];
      if (org) { conds.push(`organization_id = $${p++}`); params.push(org); }
      if (trainerId) { conds.push(`trainer_id = $${p++}`); params.push(trainerId); }
      const { rows } = await pool.query(
        `SELECT name, status, mobile, package_type, trainer_name, balance_amount, pt_end_date
         FROM pt_clients WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 3`,
        params
      );
      return rows;
    },
    format: (rows, name) => {
      if (!rows.length) return `No client matching "${name}" was found in this studio's records.`;
      return rows.map((c) =>
        `${c.name} — status: ${c.status}, plan: ${c.package_type || 'n/a'}, trainer: ${c.trainer_name || 'unassigned'}, balance due: ${fmtINR(c.balance_amount)}, PT ends: ${c.pt_end_date ? new Date(c.pt_end_date).toLocaleDateString('en-IN') : 'n/a'}`
      ).join('\n');
    },
  },

  /* ── Attendance summary ──────────────────────────────────────────────── */
  {
    name: 'attendance_summary',
    label: 'Attendance',
    roles: ['admin', 'manager', 'trainer', 'reception'],
    test: (msg) => /\b(attendance|check-?in|checked in|present|absent)\b/i.test(msg),
    async run(req, _match, message) {
      const { from, to, label } = parseDateRange(message);
      const org = orgParam(req);
      const trainerId = req.user.role === 'trainer' ? req.user.trainer_id : null;
      const params = [from, to];
      let p = 3;
      let trainerFilter = '';
      if (trainerId) {
        trainerFilter = `AND a.ref_id IN (SELECT id FROM pt_clients WHERE trainer_id = $${p++}) `;
        params.push(trainerId);
      }
      let orgFilter = '';
      if (org) { orgFilter = `AND a.organization_id = $${p++} `; params.push(org); }

      const { rows } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'present') AS present,
           COUNT(*) FILTER (WHERE status = 'absent') AS absent,
           COUNT(*) FILTER (WHERE status = 'late') AS late,
           COUNT(DISTINCT ref_id) AS unique_clients,
           COUNT(*) AS total
         FROM attendance_logs a
         WHERE a.ref_type = 'client' AND a.date BETWEEN $1::date AND $2::date ${trainerFilter}${orgFilter}`,
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
    roles: ['admin', 'manager', 'trainer'],
    test: (msg) => /\bexercises?\b.*\b(for|targeting|that work|to (train|hit))\b|\bworkout\s+(move|exercise)s?\b/i.test(msg)
      && MUSCLE_KEYWORDS.some((k) => msg.toLowerCase().includes(k)),
    extract: (msg) => {
      const lower = msg.toLowerCase();
      return MUSCLE_KEYWORDS.find((k) => lower.includes(k)) || null;
    },
    async run(_req, muscle) {
      const { rows } = await pool.query(
        `SELECT name, muscle_group, body_part, equipment, difficulty
         FROM exercises WHERE is_active = true AND (muscle_group ILIKE $1 OR body_part ILIKE $1 OR target_muscle ILIKE $1)
         ORDER BY name LIMIT 8`,
        [`%${muscle}%`]
      );
      return rows;
    },
    format: (rows, muscle) => {
      if (!rows.length) return `No exercises found in the library for "${muscle}".`;
      return `Exercises for ${muscle}:\n` + rows.map((e) => `- ${e.name} (${e.equipment || 'no equipment listed'}, ${e.difficulty || 'difficulty n/a'})`).join('\n');
    },
  },

  /* ── Revenue summary (financial data — admin/manager only) ───────────── */
  {
    name: 'revenue_summary',
    label: 'Revenue',
    roles: ['admin', 'manager'],
    test: (msg) => /\b(revenue|earnings|income|collections?)\b/i.test(msg),
    async run(req, _match, message) {
      const { from, to, label } = parseDateRange(message);
      const org = orgParam(req);
      const params = [from, to];
      let orgFilter = '';
      if (org) { orgFilter = 'AND organization_id = $3'; params.push(org); }
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
    roles: ['admin', 'manager'],
    test: (msg) => /\b(outstanding|pending)\s+dues?\b|\bwho owes\b|\bunpaid\b|\bbalance\s+(due|owed)\b/i.test(msg),
    async run(req) {
      const org = orgParam(req);
      const params = [];
      let orgFilter = '';
      if (org) { orgFilter = 'AND organization_id = $1'; params.push(org); }
      const { rows } = await pool.query(
        `SELECT name, balance_amount FROM pt_clients
         WHERE deleted_at IS NULL AND balance_amount > 0 ${orgFilter}
         ORDER BY balance_amount DESC LIMIT 10`,
        params
      );
      const total = rows.reduce((s, r) => s + Number(r.balance_amount), 0);
      return { rows, total };
    },
    format: ({ rows, total }) => {
      if (!rows.length) return 'No clients currently have an outstanding balance.';
      const top = rows.map((r) => `${r.name}: ${fmtINR(r.balance_amount)}`).join(', ');
      return `Outstanding dues: ${fmtINR(total)} total across ${rows.length} client${rows.length === 1 ? '' : 's'} (top: ${top}).`;
    },
  },

  /* ── Trainer roster ───────────────────────────────────────────────────── */
  {
    name: 'trainer_roster',
    label: 'Trainers',
    roles: ['admin', 'manager', 'trainer', 'reception'],
    test: (msg) => /\b(list|how many|who are the)\b.*\btrainers?\b/i.test(msg),
    async run(req) {
      const org = orgParam(req);
      const params = [];
      let orgFilter = '';
      if (org) { orgFilter = 'AND organization_id = $1'; params.push(org); }
      const { rows } = await pool.query(
        `SELECT name, specialization, status FROM trainers
         WHERE deleted_at IS NULL AND status = 'active' ${orgFilter} ORDER BY name`,
        params
      );
      return rows;
    },
    format: (rows) => {
      if (!rows.length) return 'No active trainers found.';
      return `Active trainers (${rows.length}): ` + rows.map((t) => `${t.name}${t.specialization ? ` (${t.specialization})` : ''}`).join(', ');
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
    const authorized = !tool.roles || tool.roles.includes(req.user.role);
    if (!authorized) {
      contextParts.push(`[${tool.label}] The current user's role ("${req.user.role}") is not permitted to view this data — say so plainly rather than answering.`);
      toolNames.push(tool.label);
      continue;
    }
    try {
      const match = tool.extract ? tool.extract(message) : null;
      if (tool.extract && !match) continue; // pattern matched but couldn't extract a usable argument
      const result = await tool.run(req, match, message);
      contextParts.push(`[${tool.label}] ${tool.format(result, match)}`);
      toolNames.push(tool.label);
    } catch (err) {
      logger.warn({ tool: tool.name, err: err.message }, 'ai_tool_run_failed');
    }
  }

  return { toolNames, contextText: contextParts.join('\n\n') };
}

module.exports = { runTools, TOOLS };
