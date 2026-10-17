'use strict';
// The one place this platform talks to Hostinger.
//
// ── Why the base URL is a literal ───────────────────────────────────────────
//
// There is no HOSTINGER_API_URL. Every parameter that reaches this file comes
// from the catalogue, and the catalogue's paths are literals starting with
// `/api/`; the host is a constant. That is the whole SSRF story here — there is
// no input, anywhere, that can change the destination, so there is nothing to
// filter. An env override would immediately create one, and a token-bearing
// request to an attacker-chosen host is the worst possible consequence of a
// configuration typo.
//
// ── Why this never throws ───────────────────────────────────────────────────
//
// Every caller is a route handler or a dashboard aggregator, and both have to
// render a partial page rather than a stack trace: "domains loaded, VPS failed"
// is a useful screen, and a thrown error turns it into a 500 that says nothing.
// So the shape here is a result object, always. A failure carries a code the
// caller can branch on, a message that is safe to show, and whether retrying
// could help.
//
// ── Pacing ─────────────────────────────────────────────────────────────────
//
// Hostinger allows 90 requests per minute per user, counted across every
// machine using the token. Responses carry `RateLimit: "api";r=<remaining>;t=<reset>`
// (plus the legacy `X-RateLimit-*` pair, which is still sent), and a 429 adds
// `Retry-After`. This client keeps its own sliding window AND honours what the
// server says, because the window alone cannot see the other callers sharing
// the budget.
//
// ── What a 429 does not do ─────────────────────────────────────────────────
//
// It does not sleep the request path indefinitely and it does not retry a POST
// that may already have taken effect. Docs: "Retrying a POST is only safe when
// you know the first attempt didn't take effect." A 429 is the one status where
// that is certain — the request was refused, not processed — so GET and 429 are
// the only automatic retries. A 500 on `vps.recreate` is reported, not resent.

const { providerSignal } = require('../providerTimeout');
const { scrubBounded } = require('../secretScrub');
const catalog = require('./catalog');

/** Documented base URL. Not configurable, deliberately. */
const BASE_URL = 'https://developers.hostinger.com';
/** Documented budget: 90 requests per minute, per user. */
const DEFAULT_LIMIT = 90;
const WINDOW_MS = 60_000;
/**
 * Leave room for the calls this process does not make: the same token may be
 * in use from hPanel, the CLI or another deployment, and the budget is shared.
 * Two requests of headroom costs nothing and turns "we got 429'd" from a race
 * into a rounding error.
 */
const HEADROOM = 2;
/** Bounded concurrency for dashboard fan-out. Three is enough to fill a card grid. */
const MAX_CONCURRENT = 3;
const MAX_ATTEMPTS = 3;
/** Ceiling on how long a 429 may park this process's Hostinger calls. */
const MAX_BACKOFF_MS = 30_000;
/** Largest upstream body we keep in memory. The response is already fully read
 *  by res.text(); this bounds what survives into the console. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Attempts that failed for a reason a retry could fix. */
const RETRYABLE_STATUS = new Set([429, 500, 502]);

// ── Pacer ───────────────────────────────────────────────────────────────────

const inWindow = [];       // timestamps of requests started in the last minute
let observedLimit = DEFAULT_LIMIT;
let remaining = null;      // as `RateLimit: …;r=`
let resetAt = 0;           // epoch ms when the window resets
let pausedUntil = 0;       // epoch ms set from Retry-After

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Read the quota the server reported, in either header spelling. */
function readQuota(res) {
  const policy = res.headers.get('ratelimit-policy');
  if (policy) {
    const q = Number((policy.match(/(?:^|;)\s*q=(\d+)/i) || [])[1]);
    if (Number.isFinite(q) && q > 0) observedLimit = q;
  } else {
    const limit = Number(res.headers.get('x-ratelimit-limit'));
    if (Number.isFinite(limit) && limit > 0) observedLimit = limit;
  }

  // `RateLimit: "api";r=89;t=60` — r is what is left, t is seconds to reset.
  const rl = res.headers.get('ratelimit');
  let r = rl ? Number((rl.match(/(?:^|;)\s*r=(\d+)/i) || [])[1]) : NaN;
  let t = rl ? Number((rl.match(/(?:^|;)\s*t=(\d+)/i) || [])[1]) : NaN;
  if (!Number.isFinite(r)) r = Number(res.headers.get('x-ratelimit-remaining'));
  if (!Number.isFinite(t)) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    // The legacy header is documented as a reset value; treat seconds-from-now
    // and epoch alike by only trusting it when it is small.
    if (Number.isFinite(reset)) t = reset > 1_000_000 ? Math.ceil(reset - Date.now() / 1000) : reset;
  }
  if (Number.isFinite(r)) remaining = r;
  if (Number.isFinite(t) && t > 0) resetAt = Date.now() + t * 1000;
}

/** Take one slot, waiting for one when the budget is spent. */
async function pace() {
  for (;;) {
    const now = Date.now();

    if (now < pausedUntil) {
      await sleep(pausedUntil - now);
      continue;
    }

    while (inWindow.length && inWindow[0] <= now - WINDOW_MS) inWindow.shift();

    // The server's own count is authoritative: it sees the other callers.
    if (remaining !== null && remaining <= HEADROOM && resetAt > now) {
      await sleep(resetAt - now);
      continue;
    }

    const ceiling = Math.max(1, observedLimit - HEADROOM);
    if (inWindow.length >= ceiling) {
      await sleep(inWindow[0] + WINDOW_MS - now + 25);
      continue;
    }

    inWindow.push(now);
    return;
  }
}

/** Back off after a 429, capped so a stuck counter cannot park the console. */
function backOff(res) {
  const header = Number(res.headers.get('retry-after'));
  const seconds = Number.isFinite(header) && header > 0 ? header : 60;
  const wait = Math.min(seconds * 1000, MAX_BACKOFF_MS);
  pausedUntil = Math.max(pausedUntil, Date.now() + wait);
  remaining = 0;
  return wait;
}

// ── Request building ────────────────────────────────────────────────────────

/**
 * Fill `{placeholders}` from validated path params.
 *
 * encodeURIComponent is belt AND braces: the catalogue's schemas already
 * forbid `/`, `?`, `#` and control characters for every documented parameter,
 * and this makes an encoding slip a wrong URL rather than a path traversal.
 */
function buildPath(op, pathParams) {
  const schemas = op.pathParams || {};
  const values = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const raw = pathParams?.[name];
    if (raw === undefined || raw === null || raw === '') {
      return { error: { code: 'INVALID_INPUT', message: `Missing ${name}`, fields: { [name]: 'required' } } };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        error: {
          code: 'INVALID_INPUT',
          message: `Invalid ${name}`,
          fields: { [name]: parsed.error.issues[0]?.message || 'invalid' },
        },
      };
    }
    values[name] = parsed.data;
  }

  let path = op.path;
  for (const [name, value] of Object.entries(values)) {
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  if (path.includes('{')) {
    return { error: { code: 'INVALID_INPUT', message: 'Unfilled path parameter' } };
  }
  return { path, values };
}

/** Query string from a validated object. Arrays repeat the parameter. */
function buildQuery(schema, raw) {
  if (!schema) return { search: '' };
  const parsed = schema.safeParse(raw || {});
  if (!parsed.success) {
    return { error: { code: 'INVALID_INPUT', message: 'Invalid query', fields: fieldErrors(parsed.error) } };
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const search = params.toString();
  return { search: search ? `?${search}` : '' };
}

function buildBody(schema, raw) {
  if (!schema) return { json: undefined, value: undefined };
  const parsed = schema.safeParse(raw || {});
  if (!parsed.success) {
    return { error: { code: 'INVALID_INPUT', message: 'Invalid body', fields: fieldErrors(parsed.error) } };
  }
  return { json: JSON.stringify(parsed.data), value: parsed.data };
}

/** zod issues → `{ field: message }`, the shape middleware/validate.js already returns. */
function fieldErrors(error) {
  const fields = {};
  for (const issue of error.issues || []) {
    const path = issue.path.join('.') || '_';
    if (!fields[path]) fields[path] = issue.message;
  }
  return fields;
}

// ── Response reading ────────────────────────────────────────────────────────

/** Parse a body defensively: upstream promises JSON, and a proxy can break that promise. */
async function readBody(res) {
  let text;
  try {
    text = await res.text();
  } catch {
    return { data: null, truncated: false };
  }
  if (text.length > MAX_BODY_BYTES) text = text.slice(0, MAX_BODY_BYTES);
  try {
    return { data: JSON.parse(text), truncated: false };
  } catch {
    // An HTML error page from a proxy. Bounded because it is displayed.
    return { data: text ? scrubBounded(text, { max: 400 }) : null, truncated: true };
  }
}

/** Every string that came from upstream is scrubbed and bounded before it travels on. */
function safeMessage(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return scrubBounded(value, { max: 400 });
}

function fail(res, body, extra) {
  const payload = body && typeof body === 'object' ? body : {};
  const status = res ? res.status : 0;
  return {
    ok: false,
    status,
    error: {
      code: extra?.code || (status === 0 ? 'NETWORK' : `HTTP_${status}`),
      message: safeMessage(payload.message || payload.error, extra?.message || `Hostinger returned ${status || 'no response'}`),
      fields: payload.errors && typeof payload.errors === 'object' ? scrubFields(payload.errors) : extra?.fields,
      correlationId: safeMessage(res?.headers.get('x-correlation-id') || payload.correlation_id, null),
      retryable: RETRYABLE_STATUS.has(status),
      ...extra,
    },
  };
}

/** 422 bodies are keyed by field name with a list of messages. Bounded and scrubbed. */
function scrubFields(errors) {
  const out = {};
  let n = 0;
  for (const [key, list] of Object.entries(errors)) {
    if (n++ > 20) break;
    const messages = Array.isArray(list) ? list : [list];
    out[safeMessage(key, '_')] = messages
      .slice(0, 5)
      .map((m) => safeMessage(typeof m === 'string' ? m : JSON.stringify(m), ''))
      .filter(Boolean);
  }
  return out;
}

// ── The call ────────────────────────────────────────────────────────────────

/**
 * Call one catalogue operation.
 *
 * @param {object}  args
 * @param {string}  args.operationId  catalogue id
 * @param {object} [args.pathParams]
 * @param {object} [args.query]
 * @param {object} [args.body]
 * @param {string}  args.token        the decrypted API token; never logged
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ok:true,status:number,data:any,safety:string}|{ok:false,status:number,error:object}>}
 */
async function call({ operationId, pathParams, query, body, token, signal }) {
  const op = catalog.get(operationId);
  if (!op) {
    return { ok: false, status: 0, error: { code: 'UNKNOWN_OPERATION', message: `Unknown operation: ${operationId}`, retryable: false } };
  }
  if (!token) {
    return { ok: false, status: 0, error: { code: 'NO_CREDENTIAL', message: 'No Hostinger API token is connected', retryable: false } };
  }
  // A GET with a body would be dropped by fetch anyway; refusing says so.
  if (body !== undefined && (op.method === 'GET' || op.method === 'DELETE')) {
    return { ok: false, status: 0, error: { code: 'INVALID_INPUT', message: `${op.method} takes no body`, retryable: false } };
  }

  const built = buildPath(op, pathParams);
  if (built.error) return { ok: false, status: 0, error: { retryable: false, ...built.error } };

  const queryString = buildQuery(op.query, query);
  if (queryString.error) return { ok: false, status: 0, error: { retryable: false, ...queryString.error } };

  const payload = buildBody(op.body, body);
  if (payload.error) return { ok: false, status: 0, error: { retryable: false, ...payload.error } };

  const url = `${BASE_URL}${built.path}${queryString.search}`;
  // The literal host plus a literal `/api/` path: this assert exists so a
  // future edit that builds a URL from anything else fails loudly.
  if (!url.startsWith(`${BASE_URL}/api/`)) {
    return { ok: false, status: 0, error: { code: 'INTERNAL', message: 'Refusing to call a URL outside the API base', retryable: false } };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (payload.json !== undefined) headers['Content-Type'] = 'application/json';

  let lastFailure;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await pace();

    let res;
    let networkError;
    try {
      res = await fetch(url, {
        method: op.method,
        headers,
        body: payload.json,
        // Redirects are refused: a 302 must never carry the bearer to another host.
        redirect: 'error',
        signal: signal || providerSignal(),
      });
    } catch (err) {
      networkError = err;
    }

    if (networkError) {
      const aborted = networkError.name === 'AbortError' || networkError.name === 'TimeoutError';
      lastFailure = {
        ok: false,
        status: 0,
        error: {
          code: aborted ? 'TIMEOUT' : 'NETWORK',
          // err.message from fetch carries the URL, never the header value.
          message: safeMessage(networkError.message, 'Could not reach Hostinger'),
          retryable: true,
        },
      };
      // A GET can be retried safely; a POST may have been processed before the
      // connection died, so it is reported once.
      if (op.method === 'GET' && attempt < MAX_ATTEMPTS) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      return lastFailure;
    }

    readQuota(res);

    if (res.status === 429) {
      const wait = backOff(res);
      lastFailure = fail(res, null, { message: `Hostinger rate limit reached; retrying in ${Math.ceil(wait / 1000)}s` });
      if (attempt < MAX_ATTEMPTS) {
        // Safe for every method: a 429 means the request was refused.
        await sleep(Math.min(wait, MAX_BACKOFF_MS));
        continue;
      }
      return lastFailure;
    }

    const { data, truncated } = await readBody(res);

    if (!res.ok) {
      const failure = fail(res, data);
      // 5xx on a write is ambiguous — the write may have landed. Report it.
      if (RETRYABLE_STATUS.has(res.status) && op.method === 'GET' && attempt < MAX_ATTEMPTS) {
        lastFailure = failure;
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      return failure;
    }

    return { ok: true, status: res.status, data, truncated, safety: op.safety, operationId };
  }

  return lastFailure || { ok: false, status: 0, error: { code: 'NETWORK', message: 'Hostinger call failed', retryable: true } };
}

// ── Bounded fan-out ─────────────────────────────────────────────────────────

/**
 * `call()` for each entry, at most MAX_CONCURRENT in flight, failures kept.
 *
 * The dashboard needs six or seven reads at once; firing them all would spend a
 * tenth of the minute's budget in one burst and make a second operator's click
 * wait. The pacer would serialise them anyway, so the limit is stated here
 * rather than left to emerge.
 */
async function mapBounded(entries, worker, limit = MAX_CONCURRENT) {
  const results = new Array(entries.length);
  let next = 0;
  const runners = new Array(Math.min(limit, entries.length || 1)).fill(0).map(async () => {
    for (;;) {
      const index = next++;
      if (index >= entries.length) return;
      results[index] = await worker(entries[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Everything the catalogue knows, for the console's operations panel.
 *
 * `specVersion` ships so the console can say which API revision its coverage
 * was taken from. "There is no terminal endpoint" is only checkable if the
 * reader knows what was checked.
 */
function describeCatalog() {
  return {
    groups: catalog.GROUPS,
    operations: catalog.describe(),
    safetyLabels: catalog.SAFETY_LABELS,
    spec: { version: catalog.SPEC_VERSION, source: catalog.SPEC_SOURCE },
  };
}

module.exports = {
  BASE_URL,
  WINDOW_MS,
  DEFAULT_LIMIT,
  MAX_CONCURRENT,
  call,
  mapBounded,
  describeCatalog,
  _internal: {
    pace,
    backOff,
    buildPath,
    readQuota,
    /** The pacer's view of the world. Testing seam only. */
    snapshot: () => ({
      inWindow: inWindow.length,
      remaining,
      resetAt,
      pausedUntil,
      observedLimit,
    }),
    reset: () => { inWindow.length = 0; remaining = null; resetAt = 0; pausedUntil = 0; observedLimit = DEFAULT_LIMIT; },
  },
};
