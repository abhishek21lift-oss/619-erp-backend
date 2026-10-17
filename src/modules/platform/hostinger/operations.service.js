'use strict';
// Hostinger operations: the read dashboard, the approval gate, and history.
//
// ── The gate, in one paragraph ──────────────────────────────────────────────
//
// A write is never one request. `plan` validates the parameters, stores exactly
// what the operator is about to see, and returns an approval id. `execute` takes
// that id, refuses it if the operator, the operation, the expiry or the stored
// fingerprint has changed, requires the operation id typed out for a
// destructive call, claims the row with a conditional UPDATE so a replayed
// click cannot run twice, and only then calls the API — with the STORED
// parameters, not the ones in the request. What was approved and what ran are
// the same bytes, and neither the browser nor the model can widen it.
//
// ── Secrets ────────────────────────────────────────────────────────────────
//
// Three catalogue operations take a write-only credential (`password`,
// `panel_password`, `root_password`). None of them is stored: the approval row
// records the FIELD NAMES, and the operator re-enters the value at execute
// time. The alternative — keeping it in the approvals table — would mean the
// platform holds a VPS root password in a database that gets dumped and
// replicated, to save one text field on a screen that already demands the
// operation be typed out.

const crypto = require('crypto');
const { pool } = require('../super-admin/shared');
const catalog = require('../../../lib/hostinger/catalog');
const client = require('../../../lib/hostinger/client');
const credentials = require('./credentials.service');

const { HostingerError } = credentials;

/** How long an approval stays valid. Long enough to read a screen, and no longer. */
const PLAN_TTL_MS = 5 * 60 * 1000;

/** The dashboard re-reads upstream at most this often. */
const DASHBOARD_MEMO_MS = 15_000;

/** Website SSL status is read per website; the dashboard checks at most this many. */
const DASHBOARD_SSL_SAMPLE = 5;
/** Metrics are read per machine and are the most expensive call; this many at most. */
const DASHBOARD_VM_SAMPLE = 3;

/** History rows per page, and the ceiling on what a caller can ask for. */
const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 200;

let dashboardMemo = { at: 0, value: null };

// ── Small helpers ───────────────────────────────────────────────────────────

/**
 * Deterministic JSON: object keys sorted at every depth, so the same
 * parameters always hash to the same string regardless of property order.
 * `JSON.stringify` does not guarantee that, and a fingerprint that changes when
 * a field moves would make every approval look tampered with.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** sha256 over the operation and its resolved parameters. */
function fingerprintOf(operation, params) {
  return crypto.createHash('sha256').update(`${operation}\n${stableStringify(params)}`).digest('hex');
}

/**
 * Split a parameter set into what may be stored and what may not.
 *
 * Every body field the catalogue flags as a secret is dropped, and its name is
 * returned so the execute step knows to ask for it again.
 */
function splitSecrets(op, params) {
  const flagged = op.secrets || [];
  if (!body0(params) || !flagged.length) return { storable: params, secretFields: [] };

  const body = { ...params.body };
  const secretFields = [];
  for (const field of flagged) {
    if (body[field] !== undefined) {
      secretFields.push(field);
      delete body[field];
    }
  }
  const storable = { ...params, body };
  // A body that held nothing but secrets is dropped rather than stored empty:
  // an empty object would still be sent upstream at execute time.
  if (!Object.keys(body).length) delete storable.body;
  return { storable, secretFields };
}

function body0(params) {
  return params && params.body && typeof params.body === 'object';
}

/** What an operator sees on the approval screen. Never a secret value. */
function buildSummary(op, operationId, params, secretFields) {
  const built = client._internal.buildPath(op, params.path || {});
  const query = {};
  for (const [k, v] of Object.entries(params.query || {})) {
    if (v !== undefined && v !== null) query[k] = v;
  }
  return {
    operation: operationId,
    summary: op.summary,
    safety: op.safety,
    requires_confirmation: op.safety === 'destructive',
    confirmation_text: op.safety === 'destructive' ? operationId : null,
    method: op.method,
    path: built.path || op.path,
    request_body: params.body || null,
    secret_fields: secretFields,
    // The one sentence the operator should read before approving.
    effect: catalog.SAFETY_LABELS[op.safety],
  };
}

/**
 * Validate a parameter set against the catalogue.
 *
 * Path, query and body are validated separately so a failure names the field
 * the operator has to fix rather than "invalid request".
 */
function validateParams(op, params) {
  const out = { path: {}, query: {}, body: undefined };

  for (const [name, schema] of Object.entries(op.pathParams || {})) {
    const parsed = schema.safeParse(params?.path?.[name]);
    if (!parsed.success) {
      throw new HostingerError(400, 'HOSTINGER_INVALID_PARAMS', `Invalid ${name}`, { [name]: parsed.error.issues[0]?.message });
    }
    out.path[name] = parsed.data;
  }

  if (op.query) {
    const parsed = op.query.safeParse(params?.query || {});
    if (!parsed.success) {
      throw new HostingerError(400, 'HOSTINGER_INVALID_PARAMS', 'Invalid query parameters', fieldErrors(parsed.error));
    }
    out.query = parsed.data;
  }

  if (op.body) {
    const parsed = op.body.safeParse(params?.body || {});
    if (!parsed.success) {
      throw new HostingerError(400, 'HOSTINGER_INVALID_PARAMS', 'Invalid request body', fieldErrors(parsed.error));
    }
    out.body = parsed.data;
  }

  return out;
}

function fieldErrors(error) {
  const fields = {};
  for (const issue of error.issues || []) {
    const path = issue.path.join('.') || '_';
    if (!fields[path]) fields[path] = issue.message;
  }
  return fields;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Call a `read` operation directly.
 *
 * Reads still go through the same validation and the same client — the only
 * thing they skip is the approval, which is the definition of the class.
 */
async function read({ operationId, params, token }) {
  const op = requireOperation(operationId);
  if (op.safety !== 'read') {
    throw new HostingerError(400, 'HOSTINGER_APPROVAL_REQUIRED', `${operationId} requires approval`);
  }
  const validated = validateParams(op, params);
  const result = await client.call({ operationId, pathParams: validated.path, query: validated.query, body: validated.body, token });
  return result;
}

/** The operation, or a 404 that names it. */
function requireOperation(operationId) {
  const op = catalog.get(String(operationId || ''));
  if (!op) {
    throw new HostingerError(404, 'HOSTINGER_UNKNOWN_OPERATION', `Unknown operation: ${operationId}`);
  }
  return op;
}

/**
 * A parameter set with any write-only credential removed.
 *
 * Used for the audit row of a read and for anything else that persists
 * parameters. Reads never carry secrets today, and this makes that an
 * invariant rather than a property of the current catalogue.
 */
function publicParams(operationId, params) {
  const op = catalog.get(String(operationId || ''));
  if (!op) return null;
  const { storable } = splitSecrets(op, validateParamsSafe(op, params));
  const out = { path: storable.path, query: storable.query };
  if (storable.body) out.body = storable.body;
  return out;
}

/** validateParams, but `null` instead of a throw: for audit, never for a call. */
function validateParamsSafe(op, params) {
  try {
    return validateParams(op, params);
  } catch {
    return { path: {}, query: {} };
  }
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * Store an approval for a write.
 *
 * The stored `params` are the ones that were validated here. Nothing on the
 * execute path reads a parameter from the request except the secrets, which
 * are never stored in the first place.
 */
async function plan({ operationId, params, actorId, actorName }) {
  const op = requireOperation(operationId);
  if (op.safety === 'read') {
    throw new HostingerError(400, 'HOSTINGER_NOT_APPROVABLE', `${operationId} is a read operation and runs without approval`);
  }
  if (!actorId) {
    throw new HostingerError(400, 'HOSTINGER_NO_ACTOR', 'An approval needs an identified operator');
  }

  const validated = validateParams(op, params);
  const { storable, secretFields } = splitSecrets(op, validated);
  const fingerprint = fingerprintOf(operationId, storable);
  const summary = buildSummary(op, operationId, storable, secretFields);
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS);

  const { rows } = await pool.query(
    `INSERT INTO platform_hostinger_approvals
       (operation, params, fingerprint, safety, summary, actor, actor_name, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, created_at, expires_at`,
    [operationId, JSON.stringify(storable), fingerprint, op.safety, JSON.stringify(summary), actorId, actorName || null, expiresAt]
  );

  return {
    approval_id: rows[0].id,
    operation: operationId,
    safety: op.safety,
    summary,
    expires_at: rows[0].expires_at,
    created_at: rows[0].created_at,
  };
}

/**
 * Run an approved write, or refuse it.
 *
 * Every refusal is a distinct code, because the operator's next step differs
 * for each: `ALREADY_EXECUTED` means look at history, `APPROVAL_EXPIRED` means
 * re-plan, `CONFIRMATION_REQUIRED` means type the operation id.
 */
async function execute({ operationId, approvalId, confirmation, secrets = {}, actorId }) {
  const op = requireOperation(operationId);
  if (!actorId) throw new HostingerError(400, 'HOSTINGER_NO_ACTOR', 'An execution needs an identified operator');
  if (!approvalId) throw new HostingerError(400, 'HOSTINGER_APPROVAL_REQUIRED', `${operationId} requires approval`);

  const { rows } = await pool.query(
    `SELECT id, operation, params, fingerprint, safety, summary, actor, status, expires_at, consumed_at
       FROM platform_hostinger_approvals
      WHERE id = $1`,
    [approvalId]
  );
  const approval = rows[0];
  if (!approval) throw new HostingerError(404, 'HOSTINGER_APPROVAL_NOT_FOUND', 'That approval no longer exists');
  if (approval.operation !== operationId) {
    throw new HostingerError(409, 'HOSTINGER_APPROVAL_MISMATCH', 'That approval was for a different operation');
  }
  if (approval.actor !== actorId) {
    // An approval is one operator's decision. Letting a second one consume it
    // would make the audit answer "who approved this?" with the wrong name.
    throw new HostingerError(403, 'HOSTINGER_APPROVAL_NOT_YOURS', 'This approval belongs to another operator');
  }
  if (approval.status !== 'pending') {
    throw new HostingerError(409, 'HOSTINGER_ALREADY_EXECUTED', `That approval was already ${approval.status}`);
  }
  if (new Date(approval.expires_at).getTime() < Date.now()) {
    await pool.query(`UPDATE platform_hostinger_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [approvalId]);
    throw new HostingerError(409, 'HOSTINGER_APPROVAL_EXPIRED', 'That approval expired. Review it and approve again.');
  }

  const stored = approval.params || {};
  if (fingerprintOf(operationId, stored) !== approval.fingerprint) {
    await pool.query(`UPDATE platform_hostinger_approvals SET status = 'denied' WHERE id = $1 AND status = 'pending'`, [approvalId]);
    throw new HostingerError(409, 'HOSTINGER_APPROVAL_TAMPERED', 'The stored parameters do not match what was approved. The approval has been voided.');
  }

  if (op.safety === 'destructive' && String(confirmation || '') !== operationId) {
    throw new HostingerError(400, 'HOSTINGER_CONFIRMATION_REQUIRED', `Type ${operationId} to confirm this operation`, { expected: operationId });
  }

  // Secrets are re-supplied, never replayed from storage. Which fields are
  // owed comes from the plan the operator read, so a catalogue change between
  // plan and execute cannot quietly change the set.
  const secretFields = Array.isArray(approval.summary?.secret_fields)
    ? approval.summary.secret_fields
    : (op.secrets || []);
  const supplied = {};
  for (const field of op.secrets || []) {
    const raw = secrets?.[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const parsed = op.body?.shape?.[field]?.safeParse(raw);
    if (!parsed?.success) {
      throw new HostingerError(400, 'HOSTINGER_INVALID_PARAMS', `Invalid ${field}`, { [field]: parsed?.error?.issues?.[0]?.message || 'invalid' });
    }
    supplied[field] = parsed.data;
  }
  const schema = op.body?.shape || {};
  const missing = secretFields.filter((f) => supplied[f] === undefined && schema[f] && !schema[f].isOptional());
  if (missing.length) {
    throw new HostingerError(400, 'HOSTINGER_SECRET_REQUIRED', `Re-enter: ${missing.join(', ')}`, { fields: missing });
  }

  // Claim atomically BEFORE calling: two requests racing on one approval must
  // not both reach the API, and the loser has to be told, not silently dropped.
  const claimed = await pool.query(
    `UPDATE platform_hostinger_approvals
        SET status = 'consumed', consumed_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [approvalId]
  );
  if (!claimed.rows.length) {
    throw new HostingerError(409, 'HOSTINGER_ALREADY_EXECUTED', 'That approval was already executed');
  }

  let token;
  try {
    ({ token } = await credentials.activeToken());
  } catch (err) {
    // The credential vanished between planning and executing. Release the
    // claim so the operator can retry after reconnecting, rather than being
    // told they already ran something they did not.
    await pool.query(
      `UPDATE platform_hostinger_approvals SET status = 'pending', consumed_at = NULL WHERE id = $1`,
      [approvalId]
    ).catch(() => {});
    throw err;
  }

  const body = { ...(stored.body || {}), ...supplied };
  const result = await client.call({
    operationId,
    pathParams: stored.path,
    query: stored.query,
    body: op.body ? body : undefined,
    token,
  });

  await pool.query(`UPDATE platform_hostinger_approvals SET result = $2 WHERE id = $1`, [
    approvalId,
    JSON.stringify({
      ok: result.ok,
      status: result.status,
      // The upstream body is not stored: it can be large, it can contain file
      // contents, and history needs the outcome rather than the payload.
      error: result.ok ? null : { code: result.error.code, message: result.error.message, correlation_id: result.error.correlationId },
    }),
  ]).catch(() => {});

  return { ...result, approval_id: approvalId, operation: operationId, safety: op.safety };
}

/** The approvals this operator still holds, newest first. Expired ones are marked as such. */
async function pendingApprovals({ actorId, limit = 20 }) {
  await pool.query(
    `UPDATE platform_hostinger_approvals SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now()`
  ).catch(() => {});
  const { rows } = await pool.query(
    `SELECT id, operation, safety, summary, created_at, expires_at
       FROM platform_hostinger_approvals
      WHERE actor = $1 AND status = 'pending' AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT $2`,
    [actorId, Math.min(Math.max(Number(limit) || 20, 1), 100)]
  );
  return rows;
}

/** Refuse an approval explicitly. Recorded, so "we decided not to" is visible. */
async function deny({ approvalId, actorId }) {
  const { rows } = await pool.query(
    `UPDATE platform_hostinger_approvals
        SET status = 'denied'
      WHERE id = $1 AND actor = $2 AND status = 'pending'
      RETURNING id, operation`,
    [approvalId, actorId]
  );
  if (!rows.length) throw new HostingerError(404, 'HOSTINGER_APPROVAL_NOT_FOUND', 'No pending approval of yours with that id');
  return rows[0];
}

// ── History ─────────────────────────────────────────────────────────────────

/** `activity_log` rows written by this module, as `hostinger.*`. */
async function history({ limit = HISTORY_DEFAULT, offset = 0, action } = {}) {
  const take = Math.min(Math.max(Number(limit) || HISTORY_DEFAULT, 1), HISTORY_MAX);
  const skip = Math.max(Number(offset) || 0, 0);
  const filter = action ? String(action).slice(0, 120) : null;

  const { rows } = await pool.query(
    `SELECT id, user_name, action, entity_type, entity_id, new_data, ip_address, created_at
       FROM activity_log
      WHERE action LIKE 'hostinger.%'
        AND ($3::text IS NULL OR action = $3)
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`,
    [take, skip, filter]
  );
  const { rows: totals } = await pool.query(
    `SELECT count(*)::int AS total FROM activity_log WHERE action LIKE 'hostinger.%'`
  );
  return { rows, total: totals[0]?.total || 0 };
}

// ── The dashboard ───────────────────────────────────────────────────────────

/**
 * Everything the console's first screen needs, from one pass of parallel reads.
 *
 * Memoised for 15 seconds. A refresh storm is the cheapest way to exhaust a
 * 90-per-minute budget, and the budget is shared with every other user of the
 * same token. Every slot carries its own outcome, so a failing VPS call leaves
 * the websites card rendered and says which one failed.
 *
 * @param {{ force?: boolean }} [opts]
 */
async function dashboard({ force = false } = {}) {
  if (!force && dashboardMemo.value && Date.now() - dashboardMemo.at < DASHBOARD_MEMO_MS) {
    return { ...dashboardMemo.value, cached: true };
  }

  const state = await credentials.status();
  // Not connected is a first-class dashboard state, not an error: the console's
  // first screen is the connect prompt, and a 409 there would render as a
  // broken page instead.
  if (state.state !== 'connected') {
    return {
      cached: false,
      connected: false,
      generated_at: new Date().toISOString(),
      credential: state,
      websites: null,
      domains: null,
      vps: null,
      orders: null,
      subscriptions: null,
      payment_methods: null,
      firewalls: null,
      ssl: {},
      resources: {},
      sampled: { ssl_checked: 0, ssl_total: 0, metrics_checked: 0, metrics_total: 0 },
    };
  }
  const { token } = await credentials.activeToken();

  /** One slot: the data, or why there is none. */
  const slot = async (operationId, params) => {
    const result = await client.call({ operationId, pathParams: params?.path, query: params?.query, body: params?.body, token });
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: { code: result.error.code, message: result.error.message } };
  };

  const [websites, domains, vps, orders, subscriptions, paymentMethods, firewalls] = await client.mapBounded(
    [
      ['hosting.website.list', { query: { per_page: 100 } }],
      ['domains.portfolio.list', {}],
      ['vps.list', {}],
      ['hosting.order.list', { query: { per_page: 100 } }],
      ['billing.subscription.list', {}],
      ['billing.payment_methods.list', {}],
      ['firewall.list', {}],
    ],
    ([id, params]) => slot(id, params)
  );

  // Second wave: everything that needs an id from the first.
  const siteList = websites.ok ? listOf(websites.data) : [];
  const vms = vps.ok ? listOf(vps.data) : [];
  const websitesToCheck = siteList.slice(0, DASHBOARD_SSL_SAMPLE);
  const vmsToCheck = vms.slice(0, DASHBOARD_VM_SAMPLE);

  const metricWindow = { date_from: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), date_to: new Date().toISOString() };

  const sslResults = await client.mapBounded(websitesToCheck, (site) =>
    slot('hosting.ssl.status', { path: { username: site.username, domain: site.domain } })
  );
  const metricResults = await client.mapBounded(vmsToCheck, (vm) =>
    slot('vps.metrics', { path: { virtualMachineId: vm.id }, query: metricWindow })
  );

  const ssl = {};
  websitesToCheck.forEach((site, i) => { ssl[site.domain] = sslResults[i]; });
  const resources = {};
  vmsToCheck.forEach((vm, i) => { resources[vm.id] = metricResults[i]; });

  const value = {
    cached: false,
    connected: true,
    generated_at: new Date().toISOString(),
    credential: state,
    websites,
    domains,
    vps,
    orders,
    subscriptions,
    payment_methods: paymentMethods,
    firewalls,
    ssl,
    resources,
    // Stated rather than implied: the dashboard samples, so "SSL looks fine"
    // must never be read as "every website was checked".
    sampled: {
      ssl_checked: websitesToCheck.length,
      ssl_total: siteList.length,
      metrics_checked: vmsToCheck.length,
      metrics_total: vms.length,
    },
  };

  dashboardMemo = { at: Date.now(), value };
  return value;
}

/** List responses arrive as `{ data: [...] }` or a bare array depending on the endpoint. */
function listOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

/** The same, for the assistant's context builder. */
const listOfPublic = listOf;

/** The metrics the API returns, under the names the API uses. */
const METRIC_KEYS = ['cpu_usage', 'ram_usage', 'disk_space', 'uptime'];

/**
 * The most recent reading of each metric.
 *
 * The documented shape is `{ cpu_usage: { unit: '%', usage: { '<epoch>': 1.45 },
 * ... } }` — one timestamp map per metric, not one object per sample. "What is
 * it doing now" is the entry with the highest timestamp; pulling the whole
 * series into a prompt would be hundreds of numbers an operator did not ask
 * for. A payload that changes shape degrades to `null` rather than throwing
 * inside the prompt builder.
 */
function lastSample(data) {
  if (!data || typeof data !== 'object') return null;
  const out = {};
  for (const key of METRIC_KEYS) {
    const metric = data[key];
    const usage = metric && typeof metric === 'object' ? metric.usage : null;
    if (!usage || typeof usage !== 'object') continue;
    const stamps = Object.keys(usage).map(Number).filter(Number.isFinite);
    if (!stamps.length) continue;
    const at = Math.max(...stamps);
    out[key] = { unit: metric.unit ?? null, value: usage[String(at)], at };
  }
  return Object.keys(out).length ? out : null;
}

/** One machine, in full: it, its actions, its backups, its snapshot and its projects. */
async function vpsDetail({ virtualMachineId }) {
  const { token } = await credentials.activeToken();
  const path = { virtualMachineId: Number(virtualMachineId) };
  const slot = async (operationId, params = {}) => {
    const result = await client.call({ operationId, pathParams: params.path || path, query: params.query, token });
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: { code: result.error.code, message: result.error.message } };
  };

  const [machine, actions, backups, snapshot, docker] = await client.mapBounded(
    [
      ['vps.get', {}],
      ['vps.actions', { query: { page: 1 } }],
      ['vps.backup.list', { query: { page: 1 } }],
      ['vps.snapshot.get', {}],
      ['vps.docker.list', {}],
    ],
    ([id, params]) => slot(id, params)
  );

  return { virtual_machine_id: path.virtualMachineId, machine, actions, backups, snapshot, docker };
}

/** One Docker project: its compose file, its containers and its logs. */
async function dockerProject({ virtualMachineId, projectName }) {
  const { token } = await credentials.activeToken();
  const path = { virtualMachineId: Number(virtualMachineId), projectName: String(projectName) };
  const slot = async (operationId) => {
    const result = await client.call({ operationId, pathParams: path, token });
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: { code: result.error.code, message: result.error.message } };
  };
  const [project, containers, logs] = await Promise.all([
    slot('vps.docker.get'),
    slot('vps.docker.containers'),
    slot('vps.docker.logs'),
  ]);
  return { ...path, project, containers, logs };
}

/** Website files, plus a file's content when a path is given. */
async function websiteFiles({ username, domain, directory, filePath, fromLine, maxLines }) {
  const { token } = await credentials.activeToken();
  const path = { username: String(username), domain: String(domain) };
  const listing = await client.call({
    operationId: 'hosting.files.list',
    pathParams: path,
    query: { directory, max_depth: 3, max_items: 500 },
    token,
  });
  if (!filePath) {
    return listing.ok
      ? { ok: true, files: listing.data }
      : { ok: false, error: { code: listing.error.code, message: listing.error.message } };
  }
  const content = await client.call({
    operationId: 'hosting.files.content',
    pathParams: path,
    query: { path: filePath, from_line: fromLine, max_lines: maxLines },
    token,
  });
  return {
    ok: content.ok,
    files: listing.ok ? listing.data : null,
    content: content.ok ? content.data : null,
    error: content.ok ? null : { code: content.error.code, message: content.error.message },
  };
}

/** The catalogue, as the console and the assistant see it. */
function listCatalogue() {
  return client.describeCatalog();
}

/** Test seam: the dashboard memo would leak between tests. */
function resetMemo() {
  dashboardMemo = { at: 0, value: null };
  if (client._internal) client._internal.reset();
}

module.exports = {
  PLAN_TTL_MS,
  DASHBOARD_MEMO_MS,
  HostingerError,
  stableStringify,
  fingerprintOf,
  requireOperation,
  validateParams,
  publicParams,
  plan,
  execute,
  deny,
  pendingApprovals,
  read,
  history,
  dashboard,
  vpsDetail,
  dockerProject,
  websiteFiles,
  listCatalogue,
  listOfPublic,
  lastSample,
  resetMemo,
};
