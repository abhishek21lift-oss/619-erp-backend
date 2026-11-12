'use strict';
// Bridges the deterministic planner to the secure registry, and renders what
// comes back as text the chat prompt can carry.
//
// Return shapes match lib/ai/tools.js exactly ({ toolNames, contextText }) so
// routes/ai.js did not need a second code path, no second orchestrator exists,
// and the legacy regex tools remain the fallback when no registry tool is
// planned. The registry's own envelope carries provenance; the rendering keeps
// it in the prompt so the model can say "as of" and "not recorded" instead of
// inventing either.
//
// ── The fallback boundary ─────────────────────────────────────────────────
//
// Null means NO_TOOL_MATCH: the deterministic planner emitted no call. That is
// the ONLY state in which lib/ai/tools.js may run the legacy readers. A planned
// call always returns envelopes — including FORBIDDEN, NO_TENANT,
// CLIENT_NOT_FOUND, BAD_ARGS, TOOL_TIMEOUT and TOOL_FAILED — and those are
// returned to the model as an honest failure. They are never converted into
// "try the legacy readers instead", because a denial or a failed read is not a
// no-match.

const { plan } = require('./planner');
const { createRegistry } = require('./registry');
const { TOOLS } = require('./read-tools');

const registry = createRegistry(TOOLS);
const labels = new Map(TOOLS.map((t) => [t.name, t.label]));

function render(envelope) {
  const label = labels.get(envelope.tool) || envelope.tool;
  if (!envelope.ok) {
    if (['FORBIDDEN', 'UNAUTHENTICATED', 'NO_TENANT'].includes(envelope.code)) {
      return `[${label}] The current user is not permitted to view this data — say so plainly rather than answering.`;
    }
    return `[${label}] This lookup failed (${envelope.code}), so no data was retrieved. `
      + 'Tell the user the read failed rather than answering from memory or estimating.';
  }

  const p = envelope.provenance || {};
  const header = [
    `[${label}]`,
    `source: ${p.source || 'unknown'}`,
    p.as_of ? `as of ${p.as_of}` : 'as of unknown',
  ];
  if (p.freshness?.stale === true) header.push('STALE');
  if ((p.missing || []).length) header.push(`missing: ${p.missing.join('; ')}`);

  return `${header.join(' · ')}\n${JSON.stringify(envelope.data)}`;
}

/**
 * Run the registry tools this message asks for, or null when none apply.
 *
 * Null is ONLY the no-match signal. Every planned call returns an envelope,
 * and a throw is allowed to propagate: the caller turns it into an explicit
 * failure, not a legacy fallback. Swallowing a thrown error here is how a
 * tenant/scope failure would silently re-enter the old tool path.
 */
async function runRegistryTools(req, message, {
  clientId,
  conversationId = null,
  messageId = null,
  correlationId = null,
} = {}) {
  const calls = plan(message, { clientId });
  if (!calls.length) return null;

  const envelopes = [];
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    envelopes.push(await registry.run(req, call.name, call.args, {
      clientId,
      conversationId,
      messageId,
      correlationId,
      ordinal: i,
      selectionReason: call.reason ?? null,
    }));
  }

  const toolNames = [...new Set(envelopes.map((e) => labels.get(e.tool) || e.tool))];
  return {
    toolNames,
    contextText: envelopes.map(render).join('\n\n'),
    envelopes,
    runs: envelopes.map((e) => ({
      tool: e.tool,
      run_id: e.run_id ?? null,
      ok: e.ok,
      code: e.code ?? null,
    })),
  };
}

module.exports = { runRegistryTools, registry, render };
