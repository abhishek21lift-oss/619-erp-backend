'use strict';
/**
 * The things the assistant is allowed to actually do.
 *
 * Everything here follows one shape, and the shape is the safety property:
 *
 *   resolve(req, params) → { recipients, message, warnings }
 *
 * resolve() is READ-ONLY and it is the only source of recipients. It runs
 * twice: once to build the plan the operator reads, and again at execute time
 * so the run cannot be pointed at anybody the client asked for. Nothing the
 * browser sends is ever treated as a list of people to message — the browser
 * sends parameters, the server decides who that means.
 *
 * Two consequences worth stating out loud:
 *
 *   A caller cannot message another organization's clients by guessing ids,
 *   because it never supplies ids at all. Every query here is org-scoped, and
 *   an org-less user resolves to organization_id = NULL, which matches no rows.
 *
 *   A caller cannot widen the blast radius by editing the request. `days` and
 *   `min_balance` are clamped server-side; asking for 3650 days gets 90.
 *
 * And one honesty rule, which exists because this codebase already had the
 * other kind of bug: if the delivery channel is not configured, that is a
 * warning ON THE PLAN, shown before the operator confirms. Not a surprise in
 * the results afterwards, and never a silent success.
 */

const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const { tenantScope } = require('../../lib/tenant-db');
const { sendText, twilioWhatsappConfigured } = require('../../services/whatsappDelivery');
const { routedChat } = require('../../lib/ai/router');
const { logUsage } = require('../../lib/ai/usage');
const { extractJson } = require('../../lib/ai/jsonExtract');
const { buildRenewalReminderPrompt, buildLeadFollowupPrompt } = require('../../lib/ai/prompts/system');

/** Clamp an incoming number into a range, falling back for junk input. */
function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** How many people one confirmation may reach. A studio roster is hundreds,
 *  not thousands; a plan bigger than this is a mistake somewhere upstream and
 *  should be looked at rather than sent. */
const MAX_RECIPIENTS = 200;

function moneyINR(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/** Rows → recipients, dropping anyone we cannot actually reach. Somebody with
 *  no mobile number is not a silent failure at send time; they are excluded
 *  here and counted, so the plan says "12 of 15, 3 have no number". */
function toRecipients(rows) {
  const reachable = [];
  const unreachable = [];
  for (const r of rows) {
    (r.mobile ? reachable : unreachable).push(r);
  }
  return { reachable, unreachable };
}

/**
 * Drafts a personalized body for every recipient in ONE model call, not one
 * call per recipient — a 200-row plan would otherwise mean up to 200
 * sequential LLM round trips inside a single synchronous HTTP request.
 *
 * Shared by every model-backed action's `draft()`. Only ever called at PLAN
 * time (see ai-actions.routes.js) — execute freezes whatever this returned
 * rather than calling it again, because model output is not deterministic:
 * re-drafting at execute would almost always produce different text than
 * what the operator approved, which would make the plan/execute fingerprint
 * check refuse a good plan every time, or force a fuzzy compare that stops
 * meaning anything.
 *
 * Anything the model doesn't return a usable draft for keeps its
 * `templateBody` — a bad/failed model call must never mean a recipient gets
 * no message at all.
 */
async function draftInOneCall({ recipients, req, intent, systemPrompt, describeBatch, logFailure }) {
  if (!recipients.length) return recipients;
  try {
    const facts = recipients.map((r) => ({ id: r.id, ...r._draftFacts }));
    const result = await routedChat({
      intent,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${describeBatch}\n\n${JSON.stringify(facts, null, 2)}` },
      ],
      temperature: 0.5,
      max_tokens: Math.min(300 * recipients.length, 8000),
    });

    logUsage({
      user_id: req.user.id,
      model: result.model,
      intent_type: intent,
      tokens_prompt: result.usage?.prompt_tokens || 0,
      tokens_completion: result.usage?.completion_tokens || 0,
      latency_ms: result.latency_ms,
      used_fallback: result.used_fallback,
    }).catch(() => {});

    const parsed = extractJson(result.content);
    const byId = new Map((parsed?.drafts || []).map((d) => [String(d.id), d.body]));

    return recipients.map((r) => {
      const drafted = byId.get(String(r.id));
      const usable = typeof drafted === 'string' && drafted.trim().length > 0 && drafted.length <= 500;
      return { ...r, body: usable ? drafted.trim() : r.templateBody, ai_drafted: usable };
    });
  } catch (err) {
    logger.warn({ err: err.message }, logFailure);
    return recipients.map((r) => ({ ...r, body: r.templateBody, ai_drafted: false }));
  }
}

const ACTIONS = [
  {
    id: 'renewal_reminders',
    title: 'Send renewal reminders',
    /** Leaves the building. The confirmation step is not decoration. */
    outward: true,
    // Drives the conditional requireAiQuota() gate on /plan (see
    // ai-actions.routes.js) and tells the route it must freeze — never
    // re-derive — the drafted text at execute time. dues_reminders has no
    // draft() and stays outside both.
    usesModel: true,
    roles: ['admin', 'manager', 'super_admin'],
    describe: (p) => `WhatsApp every active client whose package ends within ${p.days} days`,
    normalize: (body = {}) => ({ days: clampInt(body.days, { min: 1, max: 90, fallback: 7 }) }),

    async resolve(req, params) {
      const scope = tenantScope(req);
      const values = [params.days];
      let where = `deleted_at IS NULL
                   AND status = 'active'
                   AND pt_end_date IS NOT NULL
                   AND pt_end_date::DATE BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::INTERVAL`;
      if (scope.applyFilter) {
        values.push(scope.orgId);
        where += ` AND organization_id = $${values.length}`;
      }
      const { rows } = await pool.query(
        `SELECT id, name, mobile, pt_end_date::TEXT,
                (pt_end_date::DATE - CURRENT_DATE)::INT AS days_left
           FROM pt_clients
          WHERE ${where}
          ORDER BY pt_end_date ASC, id ASC
          LIMIT ${MAX_RECIPIENTS}`,
        values,
      );

      const { reachable, unreachable } = toRecipients(rows);
      const warnings = [];
      if (!twilioWhatsappConfigured()) {
        warnings.push('WhatsApp is not configured on this server — nothing will be delivered.');
      }
      if (unreachable.length) {
        warnings.push(`${unreachable.length} matching client${unreachable.length === 1 ? ' has' : 's have'} no mobile number and will be skipped.`);
      }

      return {
        // `templateBody` is the deterministic fallback every recipient
        // always carries — draft() below tries to replace it with a
        // personalized message, but a bad/failed model call must never mean
        // a client gets no reminder at all.
        recipients: reachable.map((r) => ({
          id: r.id,
          name: r.name,
          mobile: r.mobile,
          detail: r.days_left === 0 ? 'ends today' : `${r.days_left}d left`,
          templateBody: `Hi ${r.name}, your personal training package ends on ${r.pt_end_date}. Reply here to renew and keep your slot.`,
          _draftFacts: { name: r.name, days_left: r.days_left, end_date: r.pt_end_date },
        })),
        warnings,
      };
    },

    draft: (recipients, req) => draftInOneCall({
      recipients, req,
      intent: 'renew',
      systemPrompt: buildRenewalReminderPrompt(),
      describeBatch: 'Draft a reminder for each of these clients:',
      logFailure: 'renewal_reminder_draft_failed_falling_back',
    }),
  },

  {
    id: 'lead_followup',
    title: 'Send lead follow-ups',
    outward: true,
    usesModel: true,
    roles: ['admin', 'manager', 'super_admin'],
    describe: (p) => `WhatsApp every open lead whose follow-up is due within ${p.days} days`,
    normalize: (body = {}) => ({ days: clampInt(body.days, { min: 1, max: 90, fallback: 7 }) }),

    async resolve(req, params) {
      const scope = tenantScope(req);
      const values = [params.days];
      // 'converted' and 'lost' are terminal — nothing left to follow up on.
      // follow_up_date <= today+N catches anything already overdue as well
      // as what's coming due, same as renewal_reminders' own window.
      let where = `status IN ('new', 'contacted', 'trial_scheduled')
                   AND follow_up_date IS NOT NULL
                   AND follow_up_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL`;
      if (scope.applyFilter) {
        values.push(scope.orgId);
        where += ` AND organization_id = $${values.length}`;
      }
      const { rows } = await pool.query(
        `SELECT id, name, mobile, source, status, interested_package, follow_up_date::TEXT
           FROM pt_leads
          WHERE ${where}
          ORDER BY follow_up_date ASC, id ASC
          LIMIT ${MAX_RECIPIENTS}`,
        values,
      );

      const { reachable, unreachable } = toRecipients(rows);
      const warnings = [];
      if (!twilioWhatsappConfigured()) {
        warnings.push('WhatsApp is not configured on this server — nothing will be delivered.');
      }
      if (unreachable.length) {
        warnings.push(`${unreachable.length} matching lead${unreachable.length === 1 ? ' has' : 's have'} no mobile number and will be skipped.`);
      }

      return {
        recipients: reachable.map((r) => ({
          id: r.id,
          name: r.name,
          mobile: r.mobile,
          detail: r.interested_package || r.status,
          templateBody: `Hi ${r.name}, following up on your interest in personal training${r.interested_package ? ` (${r.interested_package})` : ''}. Would you like to schedule a time to chat?`,
          _draftFacts: {
            name: r.name, source: r.source, status: r.status,
            interested_package: r.interested_package, follow_up_date: r.follow_up_date,
          },
        })),
        warnings,
      };
    },

    draft: (recipients, req) => draftInOneCall({
      recipients, req,
      intent: 'lead',
      systemPrompt: buildLeadFollowupPrompt(),
      describeBatch: 'Draft a follow-up for each of these leads:',
      logFailure: 'lead_followup_draft_failed_falling_back',
    }),
  },

  {
    id: 'dues_reminders',
    title: 'Send payment reminders',
    outward: true,
    usesModel: false,
    roles: ['admin', 'manager', 'super_admin'],
    describe: (p) => `WhatsApp every client with a balance over ${moneyINR(p.min_balance)}`,
    normalize: (body = {}) => ({
      min_balance: clampInt(body.min_balance, { min: 1, max: 1_000_000, fallback: 1 }),
    }),

    async resolve(req, params) {
      const scope = tenantScope(req);
      const values = [params.min_balance];
      let where = `deleted_at IS NULL AND balance_amount >= $1`;
      if (scope.applyFilter) {
        values.push(scope.orgId);
        where += ` AND organization_id = $${values.length}`;
      }
      const { rows } = await pool.query(
        `SELECT id, name, mobile, balance_amount
           FROM pt_clients
          WHERE ${where}
          ORDER BY balance_amount DESC, id ASC
          LIMIT ${MAX_RECIPIENTS}`,
        values,
      );

      const { reachable, unreachable } = toRecipients(rows);
      const warnings = [];
      if (!twilioWhatsappConfigured()) {
        warnings.push('WhatsApp is not configured on this server — nothing will be delivered.');
      }
      if (unreachable.length) {
        warnings.push(`${unreachable.length} matching client${unreachable.length === 1 ? ' has' : 's have'} no mobile number and will be skipped.`);
      }

      return {
        recipients: reachable.map((r) => ({
          id: r.id,
          name: r.name,
          mobile: r.mobile,
          detail: moneyINR(r.balance_amount),
          templateBody: `Hi ${r.name}, a balance of ${moneyINR(r.balance_amount)} is pending on your training account. Reply here if you'd like a payment link.`,
        })),
        warnings,
      };
    },
  },
];

/**
 * Turns `resolve()`'s recipients (each carrying a `templateBody` fallback)
 * into recipients carrying the final `body` that will actually be sent.
 * Model-backed actions get one shot at drafting, at plan time only — see
 * `draft()`'s own comment for why execute never calls this again.
 */
async function finalize(action, req, recipients) {
  if (action.usesModel && typeof action.draft === 'function') {
    return action.draft(recipients, req);
  }
  return recipients.map((r) => ({ ...r, body: r.templateBody, ai_drafted: false }));
}

/**
 * Deliver one plan. Returns a per-recipient result and never throws for a
 * delivery failure — a run where four of twelve failed is a real outcome that
 * has to be reportable, not an exception that loses the other eight.
 *
 * `not_configured` is passed through from the transport rather than being
 * mapped onto 'sent' or onto 'failed'. It is neither: nothing broke, and
 * nothing was delivered.
 */
async function deliver(recipients) {
  const results = [];
  for (const r of recipients) {
    // Sequential on purpose. This is an SMS gateway with per-account rate
    // limits, and a studio-sized list finishes in seconds either way.
    const out = await sendText({ to: r.mobile, body: r.body });
    results.push({ id: r.id, name: r.name, status: out?.status ?? 'failed', error: out?.error ?? null });
  }
  return results;
}

function findAction(id) {
  return ACTIONS.find((a) => a.id === id) || null;
}

function canRun(action, user) {
  return Boolean(action && user && action.roles.includes(user.role));
}

/** What this user is allowed to see offered. */
function listFor(user) {
  return ACTIONS.filter((a) => canRun(a, user)).map((a) => ({
    id: a.id, title: a.title, outward: a.outward,
  }));
}

module.exports = { ACTIONS, MAX_RECIPIENTS, findAction, canRun, listFor, deliver, finalize, clampInt };
