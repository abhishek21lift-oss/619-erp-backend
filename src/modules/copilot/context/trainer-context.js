'use strict';
// Who is calling, for which studio, and what they may do.
//
// ── Why this is its own module ─────────────────────────────────────────────
//
// Every AI route used to answer those three questions inline, and each one
// answered slightly differently. The Copilot's answer must be identical for
// context assembly, tool execution, approvals and the no-op context route, so
// it is resolved once here and passed down.
//
// ── What it deliberately does NOT do ───────────────────────────────────────
//
// It does not re-check the ai_suite entitlement. That is decided at the mount
// (server.js studioGate('ai_suite') → requireFeature), before a handler runs,
// and duplicating it here would mean two sources of truth for one gate.
//
// It does not query the database. auth.js already reloaded the user row, and
// the tenant boundary is req.user.organization_id (lib/tenant-db.js). Reading
// it again here would add no authority — only a second place to get it wrong.

class ContextError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
    this.status = status;
  }
}

/** The execution levels a caller may hold. EXECUTE is always approval-gated. */
const LEVELS = Object.freeze(['READ', 'ANALYZE', 'DRAFT', 'EXECUTE']);

/**
 * Client-visibility policies.
 *
 * organization_wide      the existing product behaviour: a trainer sees the
 *                        studio roster. This is the default so no studio's
 *                        access changes merely because the Copilot shipped.
 * assigned_clients_only  only clients whose pt_clients.trainer_id matches the
 *                        caller's users.trainer_id. Opt-in via
 *                        COPILOT_CLIENT_ACCESS, and currently empty in
 *                        production because pt_clients.trainer_id is unset.
 */
const POLICIES = Object.freeze(['organization_wide', 'assigned_clients_only']);

/**
 * The configured policy, validated.
 *
 * An unknown value throws rather than falling back: a typo in
 * `assigned_clients_only` must not silently restore organization-wide access.
 * The request fails with a 500 naming the variable, which is visible in logs.
 */
function clientAccessPolicy(env = process.env) {
  const raw = env.COPILOT_CLIENT_ACCESS || 'organization_wide';
  if (!POLICIES.includes(raw)) {
    throw new Error(
      `COPILOT_CLIENT_ACCESS must be one of ${POLICIES.join(', ')}; received "${raw}"`
    );
  }
  return raw;
}

/** The authenticated trainer, or a typed refusal. */
function resolveIdentity(req) {
  const user = req?.user;
  if (!user?.id) {
    throw new ContextError('UNAUTHENTICATED', 401, 'Not authenticated');
  }
  if (user.role !== 'trainer') {
    throw new ContextError('FORBIDDEN', 403, 'This area is for the studio trainer.');
  }
  return {
    userId: user.id,
    name: user.name ?? null,
    role: user.role,
    trainerId: user.trainer_id ?? null,
  };
}

/**
 * The tenant, from the authenticated user row only.
 *
 * No header, body or query value is read. An account with no organization has
 * no tenant to act in and is refused; it must never become a global view.
 */
function resolveTenant(req) {
  const organizationId = req?.user?.organization_id;
  if (!organizationId) {
    throw new ContextError('NO_TENANT', 403, 'No organization context for this account');
  }
  return {
    organizationId,
    organizationName: req.user.organization_name ?? null,
  };
}

/**
 * The levels this identity holds. Unknown or non-trainer roles hold none:
 * absence of a grant, never a default grant.
 */
function resolvePermissions(identity) {
  const trainer = identity?.role === 'trainer';
  return {
    levels: trainer ? [...LEVELS] : [],
    executeRequiresApproval: true,
  };
}

/**
 * The whole context envelope the rest of the Copilot consumes.
 *
 * `policy` is injectable so tests can exercise both policies without mutating
 * process.env; production callers omit it and get the validated configuration.
 */
function resolveTrainerContext(req, { policy = clientAccessPolicy() } = {}) {
  const identity = resolveIdentity(req);
  const tenant = resolveTenant(req);
  return {
    identity,
    tenant,
    permissions: resolvePermissions(identity),
    clientAccess: { policy },
  };
}

module.exports = {
  ContextError,
  LEVELS,
  POLICIES,
  clientAccessPolicy,
  resolveIdentity,
  resolveTenant,
  resolvePermissions,
  resolveTrainerContext,
};
