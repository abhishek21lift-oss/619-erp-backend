'use strict';
// The Hostinger operations assistant.
//
// ── What it is allowed to be ───────────────────────────────────────────────
//
// It answers questions about the hosting estate and it PROPOSES operations. It
// does not run them, and it cannot: this file has no reference to
// operations.service.js's plan or execute, so there is no code path from a
// model's output to an API call. A proposal comes back to the browser, the
// browser turns it into a plan, and an operator approves it. That is not a
// guard-rail bolted on afterwards; it is the only wiring that exists.
//
// ── Secrets ────────────────────────────────────────────────────────────────
//
// Two directions, both closed:
//   * The prompt carries no credential. The catalogue is described with
//     `secret: true` flags on the write-only fields, and the dashboard snapshot
//     is reduced to the fields an operator would read out loud (see
//     `compactContext`). The token is never in either.
//   * The operator's own text is scrubbed before it is sent. Somebody pasting
//     a token into a chat box to ask "is this the right one?" must not put it
//     in a model's context, and they do that more often than you would think.
//
// A proposal that names a secret field has that field dropped and a note added:
// the assistant has no business handling a VPS root password, and a model left
// to its own devices will happily repeat one back into a chat log.

const { scrubBounded } = require('../../../lib/secretScrub');
const { routedChat } = require('../../../lib/ai/router');
const { extractJson } = require('../../../lib/ai/jsonExtract');
const catalog = require('../../../lib/hostinger/catalog');
const credentials = require('./credentials.service');
const operations = require('./operations.service');

/** Cap on the operator's question. Long prompts are where a pasted secret hides. */
const MAX_QUESTION = 1200;
/** Model output cap. A structured answer plus one proposal fits comfortably. */
const MAX_TOKENS = 900;
/** Requests per operator per hour. A stuck client should not drain the AI budget. */
const MAX_ASKS_PER_HOUR = 60;

const asks = new Map();

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A credential nobody told us about.
 *
 * Hostinger tokens have no prefix and no documented length, so when the console
 * is not connected there is no literal value to mask by name — and an operator
 * pasting a token to ask "is this the right one?" is the common case, not a rare
 * one. A long unbroken URL-safe run is therefore masked on shape alone.
 *
 * UUIDs are exempt on purpose: build ids and snapshot ids get pasted from the
 * console, and masking one would cost the operator a rephrase for nothing.
 * Over-masking a question costs one rewrite; under-masking puts a live
 * credential in a third-party model's context.
 *
 * shortcut: a credential shorter than 32 characters, or one carrying base64
 * punctuation, is masked only when the console holds it and can name it.
 */
function maskShapedCredentials(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(/\b[A-Za-z0-9_.-]{32,}\b/g, (run) => (UUID_SHAPE.test(run) ? run : '[REDACTED]'));
}

/** A simple per-actor counter. In-process, which is honest: it bounds runaway, not abuse. */
function checkRate(actorId) {
  const now = Date.now();
  const entry = asks.get(actorId) || { count: 0, resetAt: now + 3600_000 };
  if (entry.resetAt <= now) {
    entry.count = 0;
    entry.resetAt = now + 3600_000;
  }
  entry.count += 1;
  asks.set(actorId, entry);
  if (entry.count > MAX_ASKS_PER_HOUR) {
    throw new credentials.HostingerError(429, 'HOSTINGER_ASSISTANT_RATE_LIMITED', 'Too many assistant requests this hour. Try again later.');
  }
}

/**
 * The catalogue, as the model sees it.
 *
 * Ids, methods, summaries, safety classes and parameter NAMES. No zod schemas
 * (they do not serialise), no defaults, and — the point — no values. The model
 * is being asked to choose an operation and fill parameters, and it can only
 * do that if it knows what the parameters are called.
 */
function cataloguePrompt() {
  return catalog.describe().map((op) => {
    const params = op.params.map((p) => `${p.in}:${p.name}${p.required ? '*' : ''}${p.secret ? '(secret)' : ''}`).join(' ');
    return `${op.id} — ${op.method} ${op.path} [${op.safety}] ${op.summary}${params ? ` | ${params}` : ''}`;
  }).join('\n');
}

/**
 * Reduce the dashboard to what is worth putting in a prompt.
 *
 * The full payload contains every website's filesystem paths, the account
 * usernames, billing details and 100 orders. None of that helps answer "why is
 * the site slow", all of it costs tokens, and some of it an operator would not
 * want in a third-party model's context. So: names, states, uptimes, counts
 * and failures.
 */
function compactContext(snapshot) {
  if (!snapshot) return null;
  const list = (slot) => (slot?.ok ? operations.listOfPublic(slot.data) : []);
  const fail = (slot) => (slot && !slot.ok ? `${slot.error.code}: ${slot.error.message}` : null);

  return {
    websites: list(snapshot.websites).slice(0, 40).map((w) => ({
      domain: w.domain,
      username: w.username,
      type: w.type || w.website_type || null,
      enabled: w.is_enabled ?? null,
      status: w.status ?? null,
    })),
    domains: list(snapshot.domains).slice(0, 40).map((d) => ({
      domain: d.domain,
      status: d.status ?? null,
      expiring: d.expires_at ?? d.expiration_date ?? null,
    })),
    vps: list(snapshot.vps).slice(0, 10).map((v) => ({
      id: v.id,
      hostname: v.hostname ?? null,
      state: v.state ?? v.status ?? null,
      cpus: v.cpus ?? null,
      memory_mb: v.memory ?? null,
      disk_mb: v.disk ?? null,
      ipv4: Array.isArray(v.ipv4) ? v.ipv4.map((i) => i.address ?? i).slice(0, 2) : null,
    })),
    firewalls: list(snapshot.firewalls).length,
    orders: list(snapshot.orders).slice(0, 20).map((o) => ({ id: o.id, status: o.status ?? null, domain: o.domain ?? null })),
    resources: Object.entries(snapshot.resources || {}).map(([vmId, slot]) => ({
      virtual_machine_id: Number(vmId),
      error: fail(slot),
      // Metrics come back as a series of samples; the last one is the answer.
      latest: slot?.ok ? operations.lastSample(slot.data) : null,
    })),
    errors: [
      ['websites', fail(snapshot.websites)],
      ['domains', fail(snapshot.domains)],
      ['vps', fail(snapshot.vps)],
      ['orders', fail(snapshot.orders)],
      ['subscriptions', fail(snapshot.subscriptions)],
      ['billing', fail(snapshot.payment_methods)],
      ['firewall', fail(snapshot.firewalls)],
    ].filter(([, message]) => message).map(([area, message]) => ({ area, message })),
    sampled: snapshot.sampled,
  };
}

const SYSTEM = `You are the operations assistant inside the platform-owner console of a multi-tenant SaaS. The operator is a platform super admin responsible for this company's Hostinger estate: shared hosting websites, domains, DNS, and one or more VPS machines.

You answer with a single JSON object and nothing else:

{
  "answer": "markdown, at most 120 words",
  "propose": null
}

or, when the operator's request maps onto exactly one catalogue operation:

{
  "answer": "one sentence saying what you propose and what it will do",
  "propose": { "operation": "<catalogue id>", "params": { "path": {}, "query": {}, "body": {} } }
}

Rules, in order of importance:

1. You do not perform operations. A proposal is shown to the operator, who must approve it. Never claim something has been done or is being done.
2. Use ONLY operation ids from the catalogue below, and only parameter names it lists. If nothing fits, propose nothing and say so.
3. Never put a parameter flagged (secret) into a proposal. Tell the operator which fields they will be asked to enter themselves.
4. Never invent status. If the context does not contain the fact, say the console would need to check it, and propose the read operation that checks it.
5. Prefer the least consequential operation that answers the need: a read before a restart, a snapshot before anything destructive.
6. Say plainly when a request is outside this console's reach — for example there is no SSH terminal and no VPS file manager in the Hostinger API, so neither can be offered here.

Answer in the operator's language of address: short, calm, specific.`;

/**
 * Ask the assistant.
 *
 * @param {object} args
 * @param {string} args.question
 * @param {string} args.actorId
 * @returns {Promise<{answer:string, proposal:object|null, model:string, usage:object|null, context_errors:number}>}
 */
async function ask({ question, actorId }) {
  checkRate(actorId || 'anonymous');

  // The operator may paste the token itself into the question to ask whether it
  // is the right one. Hostinger tokens carry no recognisable prefix, so no
  // pattern can catch them: the literal value the process already holds is the
  // only thing that can be masked by name. One extra decrypt per question,
  // capped at MAX_ASKS_PER_HOUR, is the cheap side of that trade.
  const knownToken = await credentials.activeToken().then((c) => c.token).catch(() => null);

  // Scrub BEFORE length-capping so a pasted credential is masked even when it
  // is what makes the text long.
  const clean = scrubBounded(maskShapedCredentials(question), { max: MAX_QUESTION, secrets: [knownToken] });
  if (!clean || clean.length < 3) {
    throw new credentials.HostingerError(400, 'HOSTINGER_ASSISTANT_EMPTY', 'Ask a question about the hosting estate.');
  }

  let snapshot = null;
  let contextErrors = 0;
  try {
    snapshot = await operations.dashboard();
    contextErrors = (compactContext(snapshot)?.errors || []).length;
  } catch {
    // A question about a disconnected account is still worth answering ("the
    // token is not connected"), and a dashboard failure must not turn the
    // assistant into a 500.
    snapshot = null;
  }

  const context = compactContext(snapshot);
  const state = await credentials.status().catch(() => null);

  const messages = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        'CATALOGUE (the only operations that exist):',
        cataloguePrompt(),
        '',
        'CURRENT STATE:',
        JSON.stringify({
          credential: state ? { state: state.state, hint: state.credential?.hint || null } : null,
          context: context || 'unavailable',
        }),
        '',
        'REQUEST:',
        clean,
      ].join('\n'),
    },
  ];

  let result;
  try {
    result = await routedChat({ intent: 'ops', messages, temperature: 0.2, max_tokens: MAX_TOKENS });
  } catch (err) {
    throw new credentials.HostingerError(503, 'HOSTINGER_ASSISTANT_UNAVAILABLE', `The assistant is unavailable: ${scrubBounded(err.message, { max: 200, secrets: [knownToken] })}`);
  }

  const parsed = extractJson(result.content) || {};
  const answer = scrubBounded(parsed.answer, { max: 2000, secrets: [knownToken] }) || 'I could not produce an answer for that. Try rephrasing it.';

  return {
    answer,
    proposal: validateProposal(parsed.propose),
    model: result.model,
    usage: result.usage || null,
    used_fallback: !!result.used_fallback,
    context_errors: contextErrors,
  };
}

/**
 * Check a proposal against the catalogue before it reaches the browser.
 *
 * Two failure modes are handled: an id that does not exist (the model invented
 * one, or named an endpoint outside the 61), and a parameters object that
 * fails validation (the model guessed). Both become a `null` proposal with the
 * reason, rather than a button that 404s when pressed.
 *
 * A valid proposal for a write comes back with `requires_approval: true` and is
 * still only a PROPOSAL — the approval is created by /plan, after an operator
 * has read it.
 */
function validateProposal(propose) {
  if (!propose || typeof propose !== 'object') return null;

  const operationId = String(propose.operation || '');
  const op = catalog.get(operationId);
  if (!op) {
    return { rejected: true, reason: `The assistant named an operation that does not exist: ${scrubBounded(operationId, { max: 120 })}` };
  }

  const params = {
    path: propose.params?.path && typeof propose.params.path === 'object' ? propose.params.path : {},
    query: propose.params?.query && typeof propose.params.query === 'object' ? propose.params.query : {},
    body: propose.params?.body && typeof propose.params.body === 'object' ? propose.params.body : {},
  };

  // Drop anything the catalogue flags as a write-only credential.
  const droppedSecrets = [];
  for (const field of op.secrets || []) {
    if (params.body[field] !== undefined) {
      droppedSecrets.push(field);
      delete params.body[field];
    }
  }

  // An operation given parameters it does not have is an operation the model
  // misunderstood. Dropping them quietly would show the operator a proposal
  // that no longer does what the answer promised.
  if (!op.body && Object.keys(params.body).length) {
    return { rejected: true, reason: `${operationId} takes no request body.` };
  }
  if (!op.query && Object.keys(params.query).length) {
    return { rejected: true, reason: `${operationId} takes no query parameters.` };
  }

  let validated;
  try {
    validated = operations.validateParams(op, params);
  } catch (err) {
    return { rejected: true, reason: err.message, fields: err.details };
  }

  const needsSecondField = droppedSecrets.length > 0;
  return {
    operation: operationId,
    summary: op.summary,
    safety: op.safety,
    requires_approval: op.safety !== 'read',
    params: validated,
    secret_fields: droppedSecrets,
    note: [
      op.safety === 'read' ? null : 'Approving this is required before it runs.',
      needsSecondField ? `You will be asked to enter: ${droppedSecrets.join(', ')}. Those are never sent to the assistant.` : null,
    ].filter(Boolean).join(' ') || null,
  };
}

/** Operators who have used the assistant, for the console's usage line. */
function rateStatus(actorId) {
  const entry = asks.get(actorId);
  if (!entry || entry.resetAt <= Date.now()) return { used: 0, limit: MAX_ASKS_PER_HOUR };
  return { used: entry.count, limit: MAX_ASKS_PER_HOUR, resets_at: new Date(entry.resetAt).toISOString() };
}

module.exports = {
  MAX_QUESTION,
  MAX_ASKS_PER_HOUR,
  ask,
  validateProposal,
  compactContext,
  maskShapedCredentials,
  rateStatus,
  _internal: { checkRate, reset: () => asks.clear() },
};
