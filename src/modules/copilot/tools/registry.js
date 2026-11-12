'use strict';
// The Copilot tool registry: one server-side pipeline for every tool call.
//
// ── The security property this file exists to hold ─────────────────────────
//
// The model never chooses a tool, never supplies a client id, and never sees a
// raw service result. It receives only what an already-authorized caller asked
// for, fenced as untrusted data. Every step below — authentication, tenant,
// role, client scope, argument validation, timeout, sanitisation, audit — runs
// in this process before a handler is reached, so a prompt that convinces the
// model to "call executeSQL" changes nothing: `executeSQL` is not in the map,
// and the call never reaches a handler.
//
// ── Why a registry rather than per-route plumbing ───────────────────────────
//
// modules/client-agent/tools.js already proved the shape (zod args, org-scoped
// loads, typed refusals) for the member-facing agent. This is the same idea
// for the trainer Copilot, with the tenant and client decided by Phase 2
// instead of by the request body. Two registers would drift; there is one
// entry point, lib/ai/tools.js, and it delegates here first.
//
// READ-only by construction: MAX_LEVELS is enforced at registration, so an
// EXECUTE tool cannot be defined in Phase 3 even by mistake. DRAFT/EXECUTE
// arrive with their approval flow, not by widening this constant alone.

const crypto = require('crypto');
const logger = require('../../../lib/logger');
const { resolveTrainerContext, ContextError } = require('../context/trainer-context');
const { resolveSelectedClient } = require('../context/client-scope');
const { recordToolRun } = require('./ledger');

/** Phase 3 registers reads and nothing else. */
const MAX_LEVELS = Object.freeze(['READ']);
const SENSITIVITY = Object.freeze(['public', 'business', 'schedule', 'personal', 'clinical']);
const CLIENT_SCOPES = Object.freeze(['none', 'required']);

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_ROWS = 100;
const MAX_STRING = 2000;
const MAX_DEPTH = 6;

/** Credential-shaped keys are dropped wherever they appear in a result. */
const SECRET_KEY = /(^|_)(password|passwd|secret|token|api_?key|authorization|cookie)(_|$)|apiKey/i;

class ToolError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.status = status;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** Local calendar date, because every date the studio reports is a studio day. */
function dateOnly(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Bound what leaves the process.
 *
 * A tool that accidentally selects `*` or returns a 5,000-character free-text
 * note must not hand the model an unbounded prompt. undefined properties are
 * dropped so JSON stays honest about missing values (null means "known empty",
 * absent means "not provided").
 */
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : dateOnly(value);
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return null;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ROWS).map((v) => sanitize(v, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    if (val === undefined) continue;
    out[key] = sanitize(val, depth + 1);
  }
  return out;
}

function normalizeProvenance(provenance, tool) {
  const p = isPlainObject(provenance) ? provenance : {};
  return sanitize({
    source: p.source || tool.source,
    records: Array.isArray(p.records) ? p.records : [],
    as_of: p.as_of ?? null,
    freshness: p.freshness ?? null,
    missing: Array.isArray(p.missing) ? p.missing : [],
  });
}

function argsDigest(args) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 16);
  } catch {
    return 'unavailable';
  }
}

function validateDefinition(def, byName) {
  if (!isPlainObject(def)) throw new Error('Tool definition must be an object');
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(def.name || '')) {
    throw new Error(`Invalid tool name: ${JSON.stringify(def.name)}`);
  }
  if (byName.has(def.name)) throw new Error(`Duplicate tool name: ${def.name}`);
  if (!MAX_LEVELS.includes(def.level)) {
    throw new Error(
      `Tool "${def.name}" declares level ${def.level}; the Copilot registry is READ-only in Phase 3`
    );
  }
  if (!CLIENT_SCOPES.includes(def.clientScope)) {
    throw new Error(`Tool "${def.name}" has an invalid clientScope`);
  }
  if (!SENSITIVITY.includes(def.sensitivity)) {
    throw new Error(`Tool "${def.name}" has an invalid sensitivity`);
  }
  if (!def.args || typeof def.args.safeParse !== 'function') {
    throw new Error(`Tool "${def.name}" must declare a zod args schema`);
  }
  if (typeof def.run !== 'function') throw new Error(`Tool "${def.name}" has no handler`);
  if (!def.description) throw new Error(`Tool "${def.name}" has no description`);
  if (!def.source) throw new Error(`Tool "${def.name}" has no source`);
  const timeout = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1) {
    throw new Error(`Tool "${def.name}" has an invalid timeoutMs`);
  }
}

function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ToolError('TOOL_TIMEOUT', 504, `Tool "${name}" took too long.`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createRegistry(definitions = []) {
  const byName = new Map();
  for (const def of definitions) {
    validateDefinition(def, byName);
    byName.set(def.name, { timeoutMs: DEFAULT_TIMEOUT_MS, ...def });
  }

  /**
   * `clientId` is the only way a client enters a tool, and it comes from the
   * route's already-validated selection, not from the message or the model.
   */
  async function run(req, name, args, {
    clientId,
    conversationId = null,
    messageId = null,
    correlationId = null,
    ordinal = 0,
    selectionReason = null,
  } = {}) {
    const startedAt = Date.now();
    const toolName = typeof name === 'string' ? name.slice(0, 64) : String(name);
    let tool = null;
    let parsed = null;
    const audit = {
      event: 'copilot.tool.run',
      tool: toolName,
      user_id: req?.user?.id ?? null,
      organization_id: req?.user?.organization_id ?? null,
      client_id: null,
      level: null,
      sensitivity: null,
      args_digest: argsDigest(args),
      status: 'error',
      code: null,
      latency_ms: 0,
    };

    try {
      // 1–3. Authentication, tenant and role, from the authenticated user row.
      const ctx = resolveTrainerContext(req);
      audit.level = null;
      audit.organization_id = ctx.tenant.organizationId;

      // 4. Allowlist. An unregistered name is refused before any data read.
      tool = byName.get(toolName);
      if (!tool) throw new ToolError('UNKNOWN_TOOL', 404, 'That tool is not available.');
      audit.level = tool.level;
      audit.sensitivity = tool.sensitivity;

      if (!MAX_LEVELS.includes(tool.level)) {
        throw new ToolError('FORBIDDEN', 403, 'That tool is not available.');
      }

      // 5. Client scope, through the Phase 2 policy. Null is one answer for
      //    foreign, deleted and unassigned clients alike.
      if (tool.clientScope === 'required') {
        if (!clientId) throw new ToolError('CLIENT_REQUIRED', 400, 'Select a client first.');
        const client = await resolveSelectedClient(
          {
            organizationId: ctx.tenant.organizationId,
            trainerId: ctx.identity.trainerId,
            policy: ctx.clientAccess.policy,
          },
          clientId
        );
        if (!client) throw new ToolError('CLIENT_NOT_FOUND', 404, 'Client not found, or not visible to you.');
        audit.client_id = client.id;
      }

      // 6. Arguments, strict. Unknown keys are rejected rather than ignored so
      //    a model-invented `client_id` cannot ride along unnoticed.
      parsed = tool.args.safeParse(args ?? {});
      if (!parsed.success) {
        throw new ToolError(
          'BAD_ARGS',
          400,
          parsed.error.issues.map((i) => i.message).join('; ').slice(0, 500)
        );
      }

      // 7. Execute the approved service, bounded in time.
      const result = await withTimeout(
        Promise.resolve(tool.run({ ctx, clientId: audit.client_id, args: parsed.data, req })),
        tool.timeoutMs,
        tool.name
      );

      if (!isPlainObject(result) || result.data === undefined) {
        throw new ToolError('TOOL_FAILED', 500, 'The tool returned no data.');
      }

      // 8. Sanitise, normalise provenance.
      const envelope = {
        ok: true,
        tool: tool.name,
        level: tool.level,
        data: sanitize(result.data),
        provenance: normalizeProvenance(result.provenance, tool),
      };

      const durationMs = Date.now() - startedAt;
      if (correlationId) {
        const stored = await recordToolRun({
          organizationId: audit.organization_id,
          userId: audit.user_id,
          conversationId,
          messageId,
          correlationId,
          toolName: tool.name,
          level: tool.level,
          sensitivity: tool.sensitivity,
          clientId: audit.client_id,
          argsDigest: audit.args_digest,
          argsMeta: parsed.data,
          ok: true,
          durationMs,
          provenance: envelope.provenance,
          ordinal,
          selectionReason,
        });
        envelope.run_id = stored.run_id;
        audit.run_id = stored.run_id;
      }

      audit.status = 'ok';
      audit.latency_ms = durationMs;
      logger.info(audit, 'copilot tool run');
      return envelope;
    } catch (err) {
      const code = err instanceof ToolError || err instanceof ContextError ? err.code : 'TOOL_FAILED';
      const status = err?.status ?? 500;
      const message = code === 'TOOL_FAILED' ? 'The tool could not complete that read.' : err.message;

      if (code === 'TOOL_FAILED') {
        // Name and code only: an error message can quote SQL and schema names.
        logger.error(
          { err: { name: err?.name, code: err?.code }, tool: toolName },
          'copilot tool threw'
        );
      }

      const durationMs = Date.now() - startedAt;
      const envelope = { ok: false, tool: toolName, code, message, status };
      if (correlationId) {
        const stored = await recordToolRun({
          organizationId: audit.organization_id,
          userId: audit.user_id,
          conversationId,
          messageId,
          correlationId,
          toolName,
          level: audit.level,
          sensitivity: audit.sensitivity,
          clientId: audit.client_id,
          argsDigest: audit.args_digest,
          argsMeta: parsed?.success ? parsed.data : null,
          ok: false,
          code,
          durationMs,
          provenance: { source: tool?.source ?? null, records: [], missing: [] },
          ordinal,
          selectionReason,
        });
        envelope.run_id = stored.run_id;
        audit.run_id = stored.run_id;
      }

      audit.status = 'error';
      audit.code = code;
      audit.latency_ms = durationMs;
      logger.warn(audit, 'copilot tool failed');
      return envelope;
    }
  }

  /** Names and declarations, no handlers. Used by the catalog parity test. */
  function list() {
    return [...byName.values()].map(({ run: _run, args: _args, ...meta }) => meta);
  }

  return { run, list };
}

module.exports = {
  createRegistry,
  ToolError,
  MAX_LEVELS,
  DEFAULT_TIMEOUT_MS,
  sanitize,
};
