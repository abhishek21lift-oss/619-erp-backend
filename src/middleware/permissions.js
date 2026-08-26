'use strict';
// Server-side enforcement of the studio's role-permission matrix.
//
// Mount AFTER auth (it reads req.user) and normally after requireStaff, which
// answers the coarser question of whether the caller belongs in the back office
// at all. This one answers which parts of it they may use.
//
// See lib/permissions.js for what the matrix means and lib/permissionFlag.js
// for the three enforcement modes.

const pool = require('../db/pool');
const logger = require('../lib/logger');
const { can, ENFORCEABLE, UNCONSTRAINED_ROLES } = require('../lib/permissions');
const { permissionMode } = require('../lib/permissionFlag');

/**
 * Per-studio matrix cache.
 *
 * The matrix is read on every gated request, and it changes about once a year.
 * Without a cache this adds a round trip to /api/pt-os, /api/reports and
 * /api/invoices on every call — and with TENANT_RLS_ENFORCE on, db/pool.js
 * wraps each of those in BEGIN/set_config/COMMIT, so it is four.
 *
 * Thirty seconds, matching the user cache in middleware/auth.js, so a toggle
 * takes effect within half a minute at worst — and immediately in practice,
 * because PUT /api/settings/permissions invalidates the studio's entry.
 */
const TTL_MS = 30_000;
const MAX_ENTRIES = 200;
const cache = new Map(); // orgId -> { matrix, expiresAt }

function cacheGet(orgId) {
  const hit = cache.get(orgId);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { cache.delete(orgId); return null; }
  return hit.matrix;
}

function cacheSet(orgId, matrix) {
  // delete-then-set moves the key to the end of insertion order, so the eviction
  // below drops the least recently loaded rather than an arbitrary entry.
  cache.delete(orgId);
  cache.set(orgId, { matrix, expiresAt: Date.now() + TTL_MS });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

/** Drop a studio's cached matrix, or all of them. Called by PUT /settings/permissions. */
function invalidatePermissions(orgId) {
  if (orgId == null) cache.clear();
  else cache.delete(orgId);
}

/**
 * The studio's saved toggles, as { perm_x_y: boolean }.
 *
 * Scoped to the organisation: system_settings carries organization_id since
 * migration 180, and before it this table was platform-global — one studio's
 * permission matrix was every studio's. Reading it unscoped here would have
 * rebuilt that, one layer down.
 */
async function loadMatrix(orgId) {
  const cached = cacheGet(orgId);
  if (cached) return cached;

  const { rows } = await pool.query(
    `SELECT key, value FROM system_settings
      WHERE key LIKE 'perm\\_%' AND organization_id = $1`,
    [orgId]
  );
  const matrix = {};
  for (const r of rows) matrix[r.key] = r.value === 'true';
  cacheSet(orgId, matrix);
  return matrix;
}

/**
 * Refuse the request unless the caller's role may use `feature`.
 *
 * Fails CLOSED on a lookup error, with one exception that is deliberate: a
 * caller with no organisation. That is a platform operator, who UNCONSTRAINED_ROLES
 * already lets through, or an org-less tenant account, whose requests are
 * bounded to nothing by the tenant layer anyway — denying here would turn a
 * data-scoping outcome into a confusing 403 about permissions.
 *
 * A database failure denies. The matrix is an authorisation input, and an
 * authorisation input that cannot be read is not a reason to assume yes.
 */
function requirePermission(feature) {
  if (!ENFORCEABLE.includes(feature)) {
    // Thrown at mount time, not request time — a typo in a route definition
    // should fail the boot, not silently permit every request to that mount for
    // however long it takes somebody to notice.
    throw new Error(
      `requirePermission('${feature}') is not an enforceable feature. `
      + `Expected one of: ${ENFORCEABLE.join(', ')}`
    );
  }

  return async function permissionGate(req, res, next) {
    const mode = permissionMode();
    if (mode === 'off') return next();

    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
    }

    // Roles the matrix has no opinion about — admin and manager run the studio,
    // super_admin is the operator, and a member never reaches a staff mount.
    // Checked before the org lookup so these callers never pay for a query
    // whose answer cannot change their outcome.
    if (UNCONSTRAINED_ROLES.includes(user.role)) return next();

    const orgId = user.organization_id;
    if (!orgId) return next();

    let matrix;
    try {
      matrix = await loadMatrix(orgId);
    } catch (err) {
      logger.error(
        { err: err.message, feature, userId: user.id, orgId },
        'permission_matrix_unavailable — refusing'
      );
      return res.status(403).json({
        error: { code: 'PERMISSION_UNAVAILABLE', message: 'Could not verify your permissions. Try again.' },
      });
    }

    if (can(user.role, feature, matrix)) return next();

    const path = (req.originalUrl || req.url || '').split('?')[0];

    if (mode === 'report') {
      logger.warn(
        { feature, role: user.role, userId: user.id, orgId, path },
        'permission_would_deny — PERMISSION_ENFORCE=report, request allowed'
      );
      return next();
    }

    logger.warn(
      { feature, role: user.role, userId: user.id, orgId, path },
      'permission_denied'
    );
    return res.status(403).json({
      error: {
        code: 'PERMISSION_DENIED',
        message: `Your role does not have access to ${feature.replace(/_/g, ' ')}. Ask your studio admin.`,
      },
    });
  };
}

module.exports = { requirePermission, invalidatePermissions, loadMatrix };
