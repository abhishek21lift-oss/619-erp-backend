// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

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
      const { rows } = await pool.query(
        // member_id is needed by requireSelfOrRole (v3 RBAC) — without it,
        // members can never access /me-style routes scoped to their own id.
        // SECURITY: also filter out soft-deleted users (deleted_at IS NOT NULL)
        // so a user that an admin removed via the v3 soft-delete path can
        // never authenticate again with their old token.
        `SELECT id, name, email, role, trainer_id, member_id, branch_id, is_active
           FROM users
          WHERE id = $1
            AND COALESCE(deleted_at::text, '') = ''`,
        [decoded.id]
      );
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

module.exports = { auth, adminOnly, invalidateUserCache };
