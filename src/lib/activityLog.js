// src/lib/activityLog.js
// Shared fire-and-forget audit log helper. Extracted from src/routes/profile.js
// (previously a local copy there) so other modules (e.g. PAR-Q, workout gate)
// can log activity without duplicating this logic.
const pool = require('../db/pool');
const logger = require('../lib/logger');

async function logActivity(req, action, entityType, entityId, data) {
  try {
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
        data ? JSON.stringify(data) : null,
        req.ip || null,
        req.headers['user-agent'] || null,
      ]
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'activity log failed');
  }
}

module.exports = { logActivity };
