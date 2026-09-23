'use strict';
// Third-party integrations: what this studio has, and who configured it.
//
// ── Why there is no longer a `connect` endpoint ─────────────────────────────
//
// There was one, and it was a credential-harvesting form for credentials
// nothing consumed. `POST /:id/test` did not contact the provider: it checked
// that the string started with 'rzp_' / 'sk_' / 'SG.' and answered
// {success:true,"Connection test successful"}, so any typed nonsense of the
// right shape turned the card green. `POST /:id/connect` then wrote that
// string into integrations.api_key — TEXT, no encryption — and flipped the row
// to 'connected'.
//
// Nothing in this codebase has ever read integrations.api_key. Razorpay, the
// one payment provider that actually works, takes RAZORPAY_KEY_ID and
// RAZORPAY_KEY_SECRET from the environment (lib/razorpay.js) and never looks
// at this table. So a studio owner pasting their live secret here got a
// green badge, a plaintext secret at rest in Postgres forever, and no
// integration. The same reasoning already removed WhatsApp's entry from this
// flow; the other providers were left behind.
//
// What remains is honest: GET reports status, deriving it from server
// configuration for providers the server actually drives, and `disconnect`
// stays so a studio can clear a row left by the old flow. Adding a provider
// means wiring it for real and naming it in PROVIDERS below — not storing a
// key and hoping.
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
const { auth, requireTrainer } = require('../middleware/auth');
const { orgWhere, orgIdOf } = require('../lib/tenant-db');

const router = express.Router();
router.use(auth, requireTrainer);

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

/**
 * Integrations this server can actually drive, and how to ask.
 *
 * `managed: 'server'` means the credential lives in the environment and a
 * studio cannot change it from the UI — which is the truth for Razorpay and
 * the reason its card must not offer a key field. Anything absent from here
 * has no working backend and must not be advertised as available.
 */
const PROVIDERS = Object.freeze({
  razorpay: {
    name: 'Razorpay',
    managed: 'server',
    // Delegated rather than reading process.env here, so there is one answer to
    // "is Razorpay usable" and the checkout path and this screen cannot
    // disagree. lib/razorpay resolves its keys once at module load, which is
    // correct for env that does not change while the process runs — but it
    // does mean a key added without a restart will not show up here either,
    // matching exactly what the payment code would do with it.
    isConfigured: () => require('../lib/razorpay').isConfigured(),
  },
});

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

    // A server-managed provider's status is whatever the server's own config
    // says, not whatever a row happens to hold. A stale 'connected' row left
    // by the removed connect flow must not outrank an unset RAZORPAY_KEY_ID.
    const byId = new Map(result.rows.map((r) => [r.id, r]));
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const configured = (() => {
        try { return p.isConfigured(); } catch { return false; }
      })();
      const row = byId.get(id) ?? { id, name: p.name, connected_at: null, last_sync_at: null };
      byId.set(id, {
        ...row,
        name: row.name || p.name,
        status: configured ? 'connected' : 'unavailable',
        managed: p.managed,
      });
    }

    res.json([...byId.values()].sort((a, b) => a.id.localeCompare(b.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/integrations/:id/disconnect — clear a row the old connect flow left
//
// Kept although nothing can connect any more: studios that used the removed
// flow still have rows here, and this is how they clear one. It also nulls
// api_key, so a studio can scrub its own stored secret without waiting for
// the migration to be deployed.
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
