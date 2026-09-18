'use strict';
// src/lib/request-context.js
//
// The correlation id, carried to every log line instead of one.
//
// ── What was actually there ────────────────────────────────────────────────
//
// middleware/requestId.js mints a uuid, puts it on `req.id` and echoes it as
// an `x-request-id` header. Correct, and almost useless on its own: `req.id`
// appeared in exactly ONE log statement in the entire application — the access
// log in server.js. Every other line, in every route handler, service, worker
// and library, was written through a logger that had never heard of it.
//
// So a support call about one member's failed payment could be answered with
// "here is when a request finished and what status it returned", and nothing
// else. The lines that say WHY — the gateway refusal, the Razorpay error, the
// scoping decision — were unattributable, because nothing tied them to the
// request that produced them or to each other.
//
// ── Why AsyncLocalStorage and not a parameter ──────────────────────────────
//
// The same reason lib/tenant-context.js uses it: an Express handler, a service
// function and a pool.query() are not all reachable through one call chain a
// plain argument could ride on, but they all run inside the same async context
// Node tracks regardless of how many awaits sit between them. Threading a
// correlation id through every function signature in the app is a refactor
// nobody finishes; a pino `mixin` that reads this store is nine lines and
// covers every existing call site including child loggers.
//
// ── Deliberately separate from tenant-context ──────────────────────────────
//
// They have different lifetimes and different rules, and merging them would
// break the one that matters. runWithTenantContext is opened ONLY by the auth
// middleware, and db/pool.js treats "no store" as "platform-wide, use the
// owner connection". A request context has to be opened for EVERY request
// including unauthenticated ones — login, forgot-password, webhooks, /api/public
// — so putting the correlation id in that store would make an unauthenticated
// request look like an authenticated tenant request to the pool router, which
// is the exact confusion ownerConnection.test.js exists to prevent.

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with a correlation context attached.
 *
 * @param {{requestId?: string, route?: string, actor?: string}} context
 *   Never anything identifying. `actor` is a user ID, not a name or an email —
 *   see the logger's redact list, which exists because PII kept arriving in
 *   log lines through request bodies.
 */
function runWithRequestContext(context, fn) {
  return storage.run({ ...context }, fn);
}

/** The current context, or undefined outside a request (workers, cron, boot). */
function currentRequestContext() {
  return storage.getStore();
}

/** Just the id, which is what the log mixin wants. */
function currentRequestId() {
  const store = storage.getStore();
  return store ? store.requestId : undefined;
}

/**
 * Attach or update a field on the context already open.
 *
 * Used by the auth middleware to add the actor once it is known — the context
 * is opened before authentication (a failed login has to be traceable too), so
 * the actor arrives later than the id does.
 *
 * A no-op outside a request rather than an error: a worker calling this should
 * not crash, it should simply have nothing to update.
 */
function setRequestContext(fields) {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, fields);
}

module.exports = {
  runWithRequestContext,
  currentRequestContext,
  currentRequestId,
  setRequestContext,
};
