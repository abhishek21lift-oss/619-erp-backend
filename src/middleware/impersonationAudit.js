'use strict';
// Structural audit of writes made while impersonating a studio.
//
// ── Why this exists as well as logActivity ─────────────────────────────────
//
// lib/activityLog.js already stamps `_impersonated_by` into the rows it writes,
// which is the right thing and covers every handler that calls it. The gap is
// that calling it is a CONVENTION: a route that mutates something and never
// calls logActivity produces no row at all, and nothing about the codebase
// forces it to. For ordinary tenant writes that is an acceptable trade — the
// actor is the account that owns the data. For a platform operator acting
// inside somebody else's studio it is not, because the operator is the one
// person whose actions nobody else can reconstruct afterwards.
//
// So this runs off `req.impersonation`, which the auth middleware sets from the
// token's `imp` claim, and therefore covers every mutating request in an
// impersonated session regardless of what the handler does or forgets to do.
//
// ── Why it is fail-CLOSED, and not fire-and-forget ─────────────────────────
//
// The row is the security record. A best-effort insert that silently drops on a
// database hiccup means a privileged cross-tenant write happened with nothing
// recording it, and the absence is indistinguishable from "nothing happened" —
// which is the one property an audit trail cannot have.
//
// So the write is committed BEFORE the handler runs, and if it cannot be
// committed the request is refused with 503. An operator who cannot be audited
// does not get to act. This is a deliberate availability-for-integrity trade,
// and it is confined to impersonated writes: ordinary tenant traffic never
// reaches this code, and read-only impersonation (the default) never does
// either, because auth rejects mutating methods before this point.
//
// Recording intent before the fact also means an attempt that then fails, or
// crashes the handler, still leaves a trace. The response status is appended
// afterwards as a best-effort update — by then the security-relevant facts
// (who, as whom, what, when, from where) are already durable.

const pool = require('../db/pool');
const logger = require('../lib/logger');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Commit an audit row for an impersonated write.
 *
 * @returns {Promise<{ok: true, id: string|null} | {ok: false, err: string}>}
 *   ok:false means the caller MUST refuse the request.
 */
async function recordImpersonatedWrite(req) {
  const imp = req.impersonation;
  const method = (req.method || 'GET').toUpperCase();

  // Nothing to record: not impersonating, or a read. Reads are covered by the
  // session-level start/end events rather than a row per page view, which would
  // bury the writes in noise.
  if (!imp || SAFE_METHODS.has(method)) return { ok: true, id: null };

  const path = (req.originalUrl || req.url || '').split('?')[0];

  try {
    const { rows } = await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, new_data,
          ip_address, user_agent, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        req.user?.id || null,
        req.user?.name || null,
        'impersonated.write',
        'http_request',
        `${method} ${path}`,
        JSON.stringify({
          method,
          path,
          // The whole point of the row: the studio admin is who the app sees
          // acting, and this is who was really behind it.
          _impersonated_by: imp.by || null,
          _impersonated_by_name: imp.byName || null,
          mode: imp.ro ? 'read_only' : 'full',
          result: 'attempted',
        }),
        req.ip || null,
        req.headers?.['user-agent'] || null,
        req.user?.organization_id || null,
      ]
    );
    return { ok: true, id: rows[0]?.id || null };
  } catch (err) {
    // Straight to the logger, not swallowed: this is the branch that refuses a
    // request, and the operator will need to know why.
    logger.error(
      { err: err.message, path, method, impersonator: imp.by },
      'impersonation_audit_failed — refusing the write because it cannot be recorded',
    );
    return { ok: false, err: err.message };
  }
}

/**
 * Append the response status to a row written by recordImpersonatedWrite.
 *
 * Best-effort by design, and safe to be: the row already exists and already
 * carries everything that matters. This only upgrades "attempted" to the
 * outcome, so a failure here costs detail, never the record itself.
 */
function appendOutcome(res, auditId) {
  if (!auditId) return;
  res.on('finish', () => {
    pool.query(
      `UPDATE activity_log
          SET new_data = COALESCE(new_data, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [auditId, JSON.stringify({ result: 'completed', status: res.statusCode })]
    ).catch((err) => logger.warn({ err: err.message, auditId }, 'impersonation audit outcome not recorded'));
  });
}

module.exports = { recordImpersonatedWrite, appendOutcome, SAFE_METHODS };
