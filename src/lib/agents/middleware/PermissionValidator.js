'use strict';
const { AgentError } = require('../base/AgentError');

// Role hierarchy: each role has access to its own level and below.
const ROLE_LEVELS = {
  admin:       100,
  manager:     80,
  staff:       60,
  reception:   50,
  receptionist:50,
  trainer:     40,
  member:      10,
};

const PermissionValidator = {
  /**
   * Check that the context's userRole is in the allowed set.
   * Throws AgentError.permissionDenied if not.
   */
  requireRole(context, ...allowedRoles) {
    if (!allowedRoles.length) return; // no restriction
    const userRole = (context.userRole || '').toLowerCase();
    if (!allowedRoles.map(r => r.toLowerCase()).includes(userRole)) {
      throw AgentError.permissionDenied(
        `This action requires one of [${allowedRoles.join(', ')}]. Your role is "${context.userRole}".`
      );
    }
  },

  /**
   * Check that the context's user has at least the given role level.
   */
  requireMinRole(context, minRole) {
    const userLevel = ROLE_LEVELS[(context.userRole || '').toLowerCase()] || 0;
    const minLevel  = ROLE_LEVELS[minRole.toLowerCase()] || 0;
    if (userLevel < minLevel) {
      throw AgentError.permissionDenied(
        `This action requires at least "${minRole}" role. Your role is "${context.userRole}".`
      );
    }
  },

  /**
   * For trainer-scoped access: a trainer may only act on their own clients.
   * Admins and managers bypass this check.
   */
  requireTrainerOwnership(context, clientTrainerId) {
    if (context.isAdmin() || context.isManager()) return;
    if (context.userRole !== 'trainer') return;
    if (context.trainerId && String(context.trainerId) !== String(clientTrainerId)) {
      throw AgentError.permissionDenied(
        'Trainers can only access their own clients.'
      );
    }
  },

  /**
   * Members may only access their own data.
   */
  requireSelfOrAdmin(context, targetUserId) {
    if (context.isAdmin() || context.isManager()) return;
    if (String(context.userId) !== String(targetUserId)) {
      throw AgentError.permissionDenied('You can only access your own data.');
    }
  },
};

module.exports = { PermissionValidator };
