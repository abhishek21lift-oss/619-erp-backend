'use strict';
// Third-party integrations (Razorpay, SendGrid, Twilio…) and their API keys.
//
// ── Why this file needed more than an organization_id filter ────────────────
//
// The table's primary key WAS the integration name: one row called 'razorpay'
// for the whole platform. So `POST /api/integrations/razorpay/connect` did not
// merely read across studios, it UPSERTED across them — the second studio to
// connect Razorpay overwrote the first studio's API key, and
// `/disconnect` nulled it out for everybody.
//
// Migration 174 replaces that primary key with a unique index on
// (organization_id, id), so each studio gets its own row per integration. The
// ON CONFLICT targets below have to name the same pair, or the upsert would
// have no arbiter to match and would raise instead.
const express = require('express');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { orgWhere, orgIdOf } = require('../lib/tenant-db');

const router = express.Router();
router.use(auth, adminOnly);

/**
 * The studio this write belongs to, or null after answering the request.
 *
 * Connecting an integration is a tenant action: it stores a credential that
 * belongs to one studio. A platform super admin operating platform-wide has no
 * studio, and NULLs are distinct in the unique index — so letting one through
 * would insert a fresh unowned row on every call instead of updating anything.
 * They can still act on a studio by naming it with x-org-id, which is the same
 * mechanism the rest of the API uses.
 */
function writableOrg(req, res) {
  const orgId = orgIdOf(req);
  if (!orgId) {
    res.status(400).json({
      success: false,
      message: 'Select a studio before changing its integrations.',
    });
    return null;
  }
  return orgId;
}

// GET /api/integrations — this studio's integration statuses
//
// api_key is deliberately absent from the column list, as it always was: the
// UI needs to know an integration is connected, never what the secret is.
router.get('/', async (req, res, next) => {
  try {
    const values = [];
    const org = orgWhere(req, values);
    const result = await pool.query(
      `SELECT id, name, status, connected_at, last_sync_at
         FROM integrations WHERE 1=1${org} ORDER BY id`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/integrations/:id/test — test connection with api_key
router.post('/:id/test', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { api_key } = req.body;
    if (!api_key || api_key.trim().length < 8) {
      return res.json({ success: false, message: 'API key too short or missing' });
    }
    // Basic format validation per integration type
    const validations = {
      razorpay:  (k) => k.startsWith('rzp_'),
      stripe:    (k) => k.startsWith('sk_'),
      sendgrid:  (k) => k.startsWith('SG.'),
      twilio:    (k) => k.length >= 20,
    };
    const validate = validations[id];
    if (validate && !validate(api_key)) {
      return res.json({ success: false, message: `Invalid API key format for ${id}` });
    }
    // For integrations without strict format, accept any key >= 8 chars
    res.json({ success: true, message: 'Connection test successful' });
  } catch (err) {
    next(err);
  }
});

// POST /api/integrations/:id/connect — save API key and mark connected
router.post('/:id/connect', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { api_key, name } = req.body;
    if (!api_key) return res.status(400).json({ success: false, message: 'api_key is required' });
    const orgId = writableOrg(req, res);
    if (!orgId) return undefined;

    await pool.query(
      `INSERT INTO integrations (id, name, status, api_key, connected_at, updated_at, organization_id)
       VALUES ($1, $2, 'connected', $3, NOW(), NOW(), $4)
       ON CONFLICT (organization_id, id) DO UPDATE
         SET status       = 'connected',
             api_key      = EXCLUDED.api_key,
             name         = COALESCE(EXCLUDED.name, integrations.name),
             connected_at = COALESCE(integrations.connected_at, NOW()),
             updated_at   = NOW()`,
      [id, name || id, api_key, orgId]
    );
    res.json({ success: true, message: 'Integration connected' });
    return undefined;
  } catch (err) {
    next(err);
    return undefined;
  }
});

// POST /api/integrations/:id/disconnect — mark as disconnected
router.post('/:id/disconnect', async (req, res, next) => {
  try {
    const { id } = req.params;
    const orgId = writableOrg(req, res);
    if (!orgId) return undefined;

    await pool.query(
      `INSERT INTO integrations (id, name, status, updated_at, organization_id)
       VALUES ($1, $1, 'disconnected', NOW(), $2)
       ON CONFLICT (organization_id, id) DO UPDATE
         SET status     = 'disconnected',
             api_key    = NULL,
             updated_at = NOW()`,
      [id, orgId]
    );
    res.json({ success: true, message: 'Integration disconnected' });
    return undefined;
  } catch (err) {
    next(err);
    return undefined;
  }
});

module.exports = router;
