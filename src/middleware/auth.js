// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const logger = require('../lib/logger');

// In-memory user cache. The token only carries `id`; we re-load the row
// on every request so role / trainer_id / is_active changes propagate
// instantly. To avoid hitting Postgres on every API call, cache the
// resolved user for a short TTL.
const USER_CACHE_TTL_MS = 30000;
const userCache = new Map(); // id -> { user, expiresAt }
function _cacheGet(id) {
  const hit = userCache.get(id);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { userCache.delete(id); return null; }
  return hit.user;
}
function _cacheSet(id, user) {
  userCache.set(id, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  if (userCache.size > 500) {
    const oldest = userCache.keys().next().value;
    if (oldest !== undefined) userCache.delete(oldest);
  }
}
function invalidateUserCache(userId) {
  if (userId == null) userCache.clear();
  else userCache.delete(userId);
}

async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = header.slice(7); // Remove "Bearer "

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    let user = _cacheGet(decoded.id);
    if (!user) {
      let rows;
      try {
        const result = await pool.query(
          // member_id is needed by requireSelfOrRole (v3 RBAC) — without it,
          // members can never access /me-style routes scoped to their own id.
          // SECURITY: also filter out soft-deleted users (deleted_at IS NOT NULL)
          // so a user that an admin removed via the v3 soft-delete path can
          // never authenticate again with their old token.
          `SELECT id, name, email, role, trainer_id, member_id, branch_id, is_active
             FROM users
            WHERE id = $1
              AND (deleted_at IS NULL)`,
          [decoded.id]
        );
        rows = result.rows;
      } catch {
        // Fallback if deleted_at column doesn't exist (pre-migration)
        const result = await pool.query(
          `SELECT id, name, email, role, trainer_id, member_id, branch_id, is_active
             FROM users WHERE id = $1`,
          [decoded.id]
        );
        rows = result.rows;
      }
      user = rows[0];
      if (!user || !user.is_active) {
        return res.status(401).json({ error: 'Account not found or disabled' });
      }
      _cacheSet(user.id, user);
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Allows admin OR manager roles.
 * Use for operations that managers should be able to perform
 * (e.g. delete trainer, edit plans) but regular staff cannot.
 */
function adminOrManager(req, res, next) {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'manager') {
    return res.status(403).json({ error: 'Admin or manager access required' });
  }
  next();
}

/**
 * Factory for allowlist-based role checks.
 * Usage: router.delete('/:id', auth, requireRole(['admin','manager']), handler)
 */
function requireRole(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${roles.join(' or ')}`,
      });
    }
    next();
  };
}

/**
 * Ensures the authenticated user is either looking at their own resource
 * OR has an elevated role. Used for member-scoped routes like /me.
 *
 * @param {string} paramName - req.params key containing the resource owner's ID.
 * @param {string[]} elevatedRoles - Roles that may bypass the self-check.
 */
function requireSelfOrRole(paramName = 'id', elevatedRoles = ['admin', 'manager']) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (elevatedRoles.includes(role)) return next();
    const resourceId = req.params[paramName];
    // Support both user id and member_id comparisons
    if (req.user?.id === resourceId || req.user?.member_id === resourceId) return next();
    return res.status(403).json({ error: 'Access denied' });
  };
}

module.exports = { auth, adminOnly, adminOrManager, requireRole, requireSelfOrRole, invalidateUserCache };
