'use strict';
// The Client Agent tool registry, in-process.
//
// This is the consolidated replacement for mps-ai/src/platform/tools/registry.js.
// The tool NAMES and the data they return are unchanged, so the ClientAiPanel's
// provenance (`toolsUsed` / `toolsUnavailable`) keeps its exact meaning. What
// changed is the transport: mps-ai called the ERP over HTTP with the user's JWT;
// this registry calls the same tenant-scoped read layer directly. There is no
// URL, no token forwarding and no second authorisation model.
//
// The agent has already resolved the client through findVisibleClient() before
// run() is reached. Every read below still takes the caller's orgId and applies
// it in SQL, so a mistake in the agent's ordering cannot widen tenancy.
//
// Deliberately absent: executeSQL, fetch, shell, file access. A tool is a named
// function over a known read; nothing here accepts a table, a query or a URL.

const { z } = require('zod');
const read = require('../pt-os/client-read.service');
const { retrieveContext } = require('../../lib/ai/knowledgeBase');
const logger = require('../../lib/logger');

/** Client ids in this system are opaque strings; reject shapes that are not. */
const ClientId = z.string().trim().min(1).max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'clientId must be an opaque id');

const TOOLS = new Map();

function define(tool) {
  if (TOOLS.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
  TOOLS.set(tool.name, Object.freeze(tool));
  return tool;
}

/* ── Client read tools ─────────────────────────────────────────────────────── */

define({
  name: 'getClientSummary',
  summary: 'Overall snapshot: latest measurements, assessments, active goal, personal records, last session, recent weekly check-ins.',
  label: 'client snapshot',
  args: z.object({ clientId: ClientId }),
  load: ({ orgId, clientId }) => read.getClientSnapshot(orgId, clientId),
});

define({
  name: 'getClientProfile',
  summary: 'Profile and commercial status: name, contact, package end date, days remaining, outstanding balance, dues status.',
  label: 'client profile',
  args: z.object({ clientId: ClientId }),
  load: ({ orgId, clientId }) => read.getClientProfile(orgId, clientId),
});

define({
  name: 'getClientTrainingBrief',
  summary: 'Training readiness: PAR-Q, posture and mobility findings, lifestyle, current goal, assigned programme, recent sessions.',
  label: 'training brief',
  args: z.object({ clientId: ClientId }),
  load: ({ orgId, clientId }) => read.getClientTrainingBrief(orgId, clientId),
});

define({
  name: 'getClientSubscriptions',
  summary: 'PT packages and subscriptions held by this client, including validity.',
  label: 'subscriptions',
  args: z.object({ clientId: ClientId }),
  load: ({ orgId, clientId }) => read.getClientSubscriptions(orgId, clientId),
});

define({
  name: 'getClientRenewals',
  summary: 'Renewal history for this client.',
  label: 'renewals',
  args: z.object({ clientId: ClientId }),
  load: ({ orgId, clientId }) => read.getClientRenewals(orgId, clientId),
});

define({
  name: 'getClientAttendance',
  summary: 'Attendance records for this client.',
  label: 'attendance',
  args: z.object({ clientId: ClientId }),
  load: ({ orgId, clientId }) => read.getClientAttendance(orgId, clientId),
});

define({
  name: 'getClientPayments',
  summary: 'Payment history for this client.',
  label: 'payments',
  args: z.object({ clientId: ClientId }),
  load: ({ orgId, clientId }) => read.getClientPayments(orgId, clientId),
});

define({
  name: 'getClientCommunication',
  summary: 'Logged communication history with this client.',
  label: 'communication history',
  args: z.object({ clientId: ClientId }),
  load: ({ orgId, clientId }) => read.getClientCommunication(orgId, clientId),
});

/* ── Knowledge tool ───────────────────────────────────────────────────────────
   The same approved corpus, embedding model and document-level tenancy the
   ERP's own generators use. retrieveContext applies `is_global OR org` and the
   approved/ready gate; this tool never builds a corpus of its own. */

define({
  name: 'search_knowledge',
  summary: 'Search approved MY PT STUDIO methodology and policy documents. Returns passage excerpts in ranked order with the document title each came from — ground your method, policy and norm claims in these passages and name the document you used.',
  label: 'knowledge search',
  args: z.object({
    q: z.string().trim().min(1).max(500, 'q must be 500 characters or fewer'),
    topK: z.number().int().min(1).max(10).optional(),
  }),
  load: ({ orgId, userId, args }) => retrieveContext({
    organizationId: orgId,
    query: args.q,
    topK: args.topK,
    route: 'client_agent',
    userId,
  }),
});

function get(name) {
  return TOOLS.get(name) || null;
}

function list() {
  return [...TOOLS.values()].map((t) => ({ name: t.name, summary: t.summary }));
}

/**
 * Run one registered tool.
 *
 * Returns a RESULT OBJECT for success and failure rather than throwing on a
 * denial: the agent must be able to state "I couldn't see that" plainly instead
 * of collapsing it into a generic model failure.
 */
async function run({ name, args, orgId, userId = null, requestId = null }) {
  const tool = get(name);
  if (!tool) {
    logger.warn({ tool: name, requestId }, 'client_agent_tool_not_registered');
    return { ok: false, tool: name, code: 'UNKNOWN_TOOL', message: `No such tool: ${name}` };
  }

  const parsed = tool.args.safeParse(args || {});
  if (!parsed.success) {
    return {
      ok: false,
      tool: name,
      code: 'BAD_ARGS',
      message: parsed.error.issues.map((i) => i.message).join('; '),
    };
  }

  try {
    const data = await tool.load({
      orgId,
      clientId: parsed.data.clientId,
      userId,
      args: parsed.data,
    });
    if (data === null || data === undefined) {
      return { ok: false, tool: name, code: 'NOT_FOUND', message: 'Not found, or not visible to you.' };
    }
    return { ok: true, tool: name, label: tool.label, data };
  } catch (err) {
    // RAG outages are a different answer from "the corpus is empty" and must
    // not be reported as one (knowledgeBase throws typed errors for exactly
    // this reason).
    if (err?.code === 'RAG_UNAVAILABLE' || err?.code === 'RAG_STALE_INDEX') {
      return {
        ok: false,
        tool: name,
        code: err.code,
        message: err.code === 'RAG_STALE_INDEX'
          ? 'The knowledge index is being rebuilt; those documents could not be searched.'
          : 'The knowledge base is unavailable right now.',
      };
    }
    logger.warn({ tool: name, requestId, code: err?.code }, 'client_agent_tool_failed');
    return {
      ok: false,
      tool: name,
      code: err?.code || 'TOOL_FAILED',
      status: err?.status,
      message: 'That information could not be retrieved right now.',
    };
  }
}

module.exports = { define, get, list, run, TOOLS, ClientId };
