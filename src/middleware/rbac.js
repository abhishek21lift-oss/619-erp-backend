// src/middleware/rbac.js
// Role-Based Access Control. Use after auth() middleware.
//
// Usage:
//   router.get('/admin-only', auth, requireRole('admin'), handler);
//   router.get('/staff',      auth, requireRole('admin','trainer'), handler);
//   router.get('/own-or-admin/:id', auth, requireSelfOrRole('admin'), handler);

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: `Requires one of: ${roles.join(', ')}` },
      });
    }
    next();
  };
}

// Allow a member to access only their own resource (matched by :id in URL)
// or any user with one of the elevated roles.
function requireSelfOrRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
    if (roles.includes(req.user.role)) return next();

    // For members: id in URL must match their member_id
    if (req.user.role === 'member' && req.params.id && req.params.id === req.user.member_id) {
      return next();
    }
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot access this resource' } });
  };
}

// For trainers: only allow access to assigned members.
//
// IMPORTANT: this is a middleware FACTORY, so it must be a synchronous
// function that returns the middleware. The previous version was declared
// `async function`, which made `requireTrainerOwnership(pool)` resolve to
// a Promise — Express then tried to use the Promise as middleware and
// every request hung. Using a plain function fixes that.
function requireTrainerOwnership(pool, paramName = 'id') {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTH' } });
    if (req.user.role === 'admin') return next();
    if (req.user.role !== 'trainer') return res.status(403).json({ error: { code: 'FORBIDDEN' } });

    const memberId = req.params[paramName];
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM clients WHERE id = $1 AND trainer_id = $2
         UNION
         SELECT 1 FROM pt_clients WHERE id = $1 AND trainer_id = $2
         LIMIT 1`,
        [memberId, req.user.trainer_id]
      );
      if (rows.length === 0) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Member not assigned to you' } });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireRole, requireSelfOrRole, requireTrainerOwnership };
