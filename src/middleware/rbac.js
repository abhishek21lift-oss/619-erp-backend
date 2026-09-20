// src/middleware/rbac.js
// Role-Based Access Control. Use after auth() middleware.
//
// Usage:
//   router.get('/trainer-only', auth, requireRole('trainer'), handler);
//   router.get('/staff',        auth, requireStaff, handler);
//   router.get('/own-or-trainer/:id', auth, requireSelfOrRole('trainer'), handler);

function normalizeRole(role) {
  if (role === 'admin' || role === 'manager' || role === 'staff' || role === 'reception' || role === 'receptionist') {
    return 'trainer';
  }
  return role;
}

function requireRole(...roles) {
  const allowed = roles.map(r => normalizeRole(r));
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
    const userRole = normalizeRole(req.user.role);
    if (userRole === 'super_admin' || allowed.includes(userRole) || allowed.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: `Requires one of: ${roles.join(', ')}` },
    });
  };
}

// Allow a member to access only their own resource (matched by :id in URL)
// or any user with one of the elevated roles.
function requireSelfOrRole(...roles) {
  const allowed = roles.map(r => normalizeRole(r));
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
    const userRole = normalizeRole(req.user.role);
    if (userRole === 'super_admin' || allowed.includes(userRole) || allowed.includes(req.user.role)) {
      return next();
    }

    // For members: the id in the URL must be their own pt_client_id.
    if (
      req.user.role === 'member' && req.params.id
      && req.params.id === req.user.pt_client_id
    ) {
      return next();
    }
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot access this resource' } });
  };
}

// In the 1 Studio = 1 Trainer model, the trainer is the studio owner and has
// full access to all clients in their organization (tenancy isolated via organization_id).
function requireTrainerOwnership(pool, paramName = 'id') {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTH' } });
    const userRole = normalizeRole(req.user.role);
    if (userRole === 'trainer' || userRole === 'super_admin') return next();
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
  };
}

/**
 * The roles that run a studio (trainer = studio owner, super_admin = platform operator).
 */
const STAFF_ROLES = ['super_admin', 'trainer'];

/**
 * Everything behind a studio's back office.
 */
function requireStaff(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
  }
  const userRole = normalizeRole(req.user.role);
  if (!STAFF_ROLES.includes(userRole) && !STAFF_ROLES.includes(req.user.role)) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'This area is for studio staff.' },
    });
  }
  next();
}

/**
 * The mirror of requireStaff: a client, acting on their own behalf.
 */
function requireClient(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
  }
  if (req.user.role !== 'member' || !req.user.pt_client_id) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'This area is for client accounts.' },
    });
  }
  next();
}

module.exports = {
  requireRole, requireSelfOrRole, requireTrainerOwnership,
  requireStaff, requireClient, STAFF_ROLES,
};
