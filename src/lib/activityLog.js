// src/lib/activityLog.js
// Shared fire-and-forget audit log helper. Extracted from src/routes/profile.js
// (previously a local copy there) so other modules (e.g. PAR-Q, workout gate)
// can log activity without duplicating this logic.
const pool = require('../db/pool');
const logger = require('../lib/logger');

async function logActivity(req, action, entityType, entityId, data) {
  try {
    // Impersonation attribution: when a super-admin is acting inside a studio in
    // full (write) mode, the row is attributed to the studio admin (req.user),
    // so stamp who was really behind it into the JSONB payload. No schema change
    // — new_data is JSONB. Read-only sessions never reach a write, so this only
    // ever tags genuine full-access actions.
    let payload = data || null;
    if (req.impersonation) {
      payload = {
        ...(data || {}),
        _impersonated_by: req.impersonation.by || null,
        _impersonated_by_name: req.impersonation.byName || 'Super Admin',
      };
    }
    await pool.query(
      `INSERT INTO activity_log
        (user_id, user_name, action, entity_type, entity_id, new_data, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        req.user.id,
        req.user.name || null,
        action,
        entityType || 'profile',
        entityId || req.user.id,
        payload ? JSON.stringify(payload) : null,
        req.ip || null,
        req.headers['user-agent'] || null,
      ]
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'activity log failed');
  }
}

module.exports = { logActivity };
