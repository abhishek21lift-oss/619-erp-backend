'use strict';
// src/routes/whatsapp.js
//
// Settings → Integrations → WhatsApp. The studio-facing half of the
// self-hosted gateway.
//
// ── Why this is a separate router from routes/integrations.js ───────────────
//
// integrations.js owns generic `/:id/connect`, `/:id/disconnect` and
// `/:id/test` routes over a table of API keys. Adding WhatsApp there would put
// `/whatsapp/connect` in reach of `/:id/connect` with id='whatsapp' — which
// would store an api_key nothing reads and report success, because that is what
// that handler does. Mounting this router at `/api/integrations/whatsapp`
// BEFORE the generic one in server.js means the specific paths win.
//
// It also keeps the two apart on their merits: everything in integrations.js is
// "paste a credential"; this is a device pairing with a lifecycle.
//
// ── Tenancy ─────────────────────────────────────────────────────────────────
//
// The organization is resolved from the authenticated session via orgIdOf(req)
// and is NEVER read from the body, the query string, or a client header. That
// is the same rule lib/tenant-db.js documents, and the reason it exists: the
// RLS GUC and the application filter must not be able to disagree about the
// active tenant within one request.

const express = require('express');
const crypto  = require('crypto');
const pool    = require('../db/pool');
const logger  = require('../lib/logger');
const gateway = require('../lib/whatsappGateway');
const { auth, adminOnly } = require('../middleware/auth');
const { orgIdOf } = require('../lib/tenant-db');

const router = express.Router();

// adminOnly, not just auth. server.js's gate() is auth + feature flag and says
// nothing about role — the comment there records a real escalation where a
// `member` account satisfied every check and read staff data. Connecting a
// studio's WhatsApp number is an owner action.
router.use(auth, adminOnly);

/**
 * The studio this request acts for, or null after answering.
 *
 * A platform super_admin operating platform-wide has no organization, and
 * pairing a WhatsApp number has no platform-wide meaning. Same 400 and the same
 * wording as writableOrg() in integrations.js, deliberately — two ways of
 * saying "pick a studio" would read as two different problems.
 */
function requireOrg(req, res) {
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
 * States in which the gateway is already holding a socket open, or opening one.
 *
 * Mirrors isLive() in the gateway's src/domain/instance.ts. The two must agree:
 * /connect below uses this to decide whether pressing Connect has to restart
 * pairing, and calling it "live" when it is not leaves a studio with a button
 * that does nothing (see the comment there).
 */
const LIVE_STATES = new Set(['connecting', 'connected', 'reconnecting']);

/** This studio's instance row, or null. */
async function loadInstance(orgId) {
  const { rows } = await pool.query(
    `SELECT instance_id, status, phone_e164, last_error_code,
            connected_at, disconnected_at, updated_at
       FROM whatsapp_instances
      WHERE organization_id = $1`,
    [orgId]
  );
  return rows[0] || null;
}

/**
 * What the UI renders.
 *
 * `stale` is the honest flag: it means the row is the last thing we were told,
 * and the gateway could not be reached to confirm it. The card greys out rather
 * than showing an error, because "we cannot check right now" is not the same as
 * "your WhatsApp is broken" — and for a studio those two read very differently.
 */
function present(row, { stale = false, configured = true } = {}) {
  if (!row) {
    return { state: 'never_connected', configured, stale: false, phone_e164: null };
  }
  return {
    state: row.status,
    phone_e164: row.phone_e164 || null,
    connected_at: row.connected_at || null,
    disconnected_at: row.disconnected_at || null,
    last_error_code: row.last_error_code || null,
    updated_at: row.updated_at || null,
    configured,
    stale,
  };
}

// ── GET /api/integrations/whatsapp/status ───────────────────────────────────
//
// Merges our row with the gateway's live view. The gateway is authoritative on
// CONNECTION state; this database is authoritative on the business record.
// Events reconcile them, and this call is the tiebreak when one was missed.
router.get('/status', async (req, res, next) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return undefined;

    const row = await loadInstance(orgId);
    if (!row) return res.json(present(null, { configured: gateway.isConfigured() }));

    if (!gateway.isConfigured()) {
      return res.json(present(row, { stale: true, configured: false }));
    }

    const live = await gateway.status(orgId, row.instance_id, req.id);
    if (!live.ok) {
      // Serve what we know. An unreachable gateway must not turn the settings
      // page into an error page.
      return res.json(present(row, { stale: true }));
    }

    // Refresh the row when the gateway disagrees — a missed webhook is exactly
    // the case this reconciles.
    if (live.data && live.data.state && live.data.state !== row.status) {
      await pool.query(
        `UPDATE whatsapp_instances
            SET status = $3, phone_e164 = COALESCE($4, phone_e164),
                last_error_code = $5, updated_at = NOW()
          WHERE instance_id = $1 AND organization_id = $2`,
        [
          row.instance_id,
          orgId,
          live.data.state,
          live.data.phone_e164 || null,
          live.data.last_error_code || null,
        ]
      );
      row.status = live.data.state;
      row.phone_e164 = live.data.phone_e164 || row.phone_e164;
      row.last_error_code = live.data.last_error_code || null;
    }

    return res.json(present(row));
  } catch (err) {
    next(err);
    return undefined;
  }
});

// ── POST /api/integrations/whatsapp/connect ─────────────────────────────────
//
// Creates the instance and starts pairing. Idempotent in the way that matters:
// pressing Connect twice, or a retry after a dropped response, reuses the
// existing instance rather than creating a second one — but it always leaves
// pairing actually running, restarting it when the gateway says the instance
// is not live. See the comment on that branch for the production bug this is.
router.post('/connect', async (req, res, next) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return undefined;

    if (!gateway.isConfigured()) {
      return res.status(503).json({
        success: false,
        code: 'GATEWAY_NOT_CONFIGURED',
        message: 'The WhatsApp gateway is not configured on this server.',
      });
    }

    // Our row FIRST, so the instance id exists here before a socket exists
    // there. If the gateway generated the id instead, a create whose response
    // was lost would leave a live socket that nothing could address.
    let row = await loadInstance(orgId);
    if (!row) {
      const instanceId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO whatsapp_instances (organization_id, instance_id, status)
         VALUES ($1, $2, 'connecting')
         ON CONFLICT (organization_id) DO NOTHING`,
        [orgId, instanceId]
      );
      // Re-read rather than trusting the insert: a concurrent request may have
      // won the ON CONFLICT, and we must use the id that actually landed.
      row = await loadInstance(orgId);
    }

    const created = await gateway.createInstance(orgId, row.instance_id, req.id);
    if (!created.ok) {
      logger.warn(
        { org_id: orgId, code: created.code, status: created.status },
        'whatsapp_connect_gateway_failed'
      );
      return res.status(502).json({
        success: false,
        code: created.code || 'GATEWAY_UNREACHABLE',
        message: 'Could not reach the WhatsApp service. Try again in a moment.',
      });
    }

    // ── Why a create is not enough on its own ───────────────────────────────
    //
    // The gateway's create is idempotent, and idempotent there means it does
    // not touch an instance that already exists: registry.create() returns
    // that instance's CURRENT state and starts no socket. That is the right
    // behaviour for a retried create — a lost response must not restart a live
    // pairing — but it is not what this route promises.
    //
    // The row above is created once and then lives forever, so from the second
    // press onwards every Connect took that branch. A studio whose first
    // attempt did not complete — nobody scanned within WA_QR_MAX_ROUNDS, or
    // the socket closed — was left with an instance no button could revive:
    // Connect no-opped, no socket opened, no QR was written, and GET /qr
    // answered 410 QR_EXPIRED forever after. On screen that is the pairing
    // dialog reading "The code expired. Press Show a new code to try again."
    // above a button that does exactly nothing. That is the state production
    // was found in.
    //
    // `reconnect` is the call that actually starts pairing again, and it
    // resets the connector rather than resuming it — which is precisely what
    // someone pressing Connect is asking for. So: create to guarantee the
    // instance exists, then restart it whenever the gateway reports it is not
    // already holding a socket open.
    let state = (created.data && created.data.state) || 'connecting';

    if (!LIVE_STATES.has(state)) {
      const restarted = await gateway.reconnect(orgId, row.instance_id, req.id);
      if (restarted.ok) {
        state = (restarted.data && restarted.data.state) || 'connecting';
      } else if (restarted.code === 'INSTANCE_CONFLICT') {
        // The gateway refuses to restart something already connected. The
        // state we read a moment ago was simply stale — the studio asked to be
        // connected and it is, so this is a success, not a failure.
        state = 'connected';
      } else {
        logger.warn(
          { org_id: orgId, code: restarted.code, status: restarted.status },
          'whatsapp_connect_restart_failed'
        );
        return res.status(502).json({
          success: false,
          code: restarted.code || 'GATEWAY_UNREACHABLE',
          message: 'Could not reach the WhatsApp service. Try again in a moment.',
        });
      }
    }

    // Keep the row in step with what we just asked for. The webhook confirms
    // it a moment later; without this the card behind the pairing dialog keeps
    // reporting the state the instance was in BEFORE this press, which reads
    // as a connect that failed.
    if (state !== row.status) {
      await pool.query(
        `UPDATE whatsapp_instances
            SET status = $3, updated_at = NOW()
          WHERE instance_id = $1 AND organization_id = $2`,
        [row.instance_id, orgId, state]
      );
    }

    return res.json({ success: true, state });
  } catch (err) {
    next(err);
    return undefined;
  }
});

// ── GET /api/integrations/whatsapp/qr ───────────────────────────────────────
//
// Proxied, never stored. A QR is a pairing credential: anyone who scans it
// links a device to this studio's WhatsApp. It is not written to this database,
// not logged, and not put in an event.
router.get('/qr', async (req, res, next) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return undefined;

    const row = await loadInstance(orgId);
    if (!row) {
      return res.status(404).json({ success: false, code: 'NOT_CONNECTED', message: 'Not connected.' });
    }

    const qr = await gateway.qr(orgId, row.instance_id, req.id);
    if (qr.ok) return res.json(qr.data);

    // The gateway's codes are passed through unchanged so the UI can tell
    // "expired, press Connect again" from "already paired" — two states that
    // need very different words on screen.
    const status = qr.code === 'QR_EXPIRED' ? 410 : qr.code === 'INSTANCE_CONFLICT' ? 409 : 502;
    return res.status(status).json({
      success: false,
      code: qr.code || 'GATEWAY_UNREACHABLE',
      message:
        qr.code === 'QR_EXPIRED'
          ? 'The QR code expired. Start again.'
          : qr.code === 'INSTANCE_CONFLICT'
            ? 'WhatsApp is already connected.'
            : 'Could not reach the WhatsApp service.',
    });
  } catch (err) {
    next(err);
    return undefined;
  }
});

// ── POST /api/integrations/whatsapp/reconnect ───────────────────────────────
router.post('/reconnect', async (req, res, next) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return undefined;

    const row = await loadInstance(orgId);
    if (!row) {
      return res.status(404).json({ success: false, code: 'NOT_CONNECTED', message: 'Not connected.' });
    }

    const result = await gateway.reconnect(orgId, row.instance_id, req.id);
    if (!result.ok) {
      return res.status(result.code === 'INSTANCE_CONFLICT' ? 409 : 502).json({
        success: false,
        code: result.code || 'GATEWAY_UNREACHABLE',
        message:
          result.code === 'INSTANCE_CONFLICT'
            ? 'WhatsApp is already connected.'
            : 'Could not reach the WhatsApp service.',
      });
    }
    return res.json({ success: true, state: (result.data && result.data.state) || 'connecting' });
  } catch (err) {
    next(err);
    return undefined;
  }
});

// ── POST /api/integrations/whatsapp/disconnect ──────────────────────────────
//
// The reversible pause: the socket closes, credentials are KEPT, and
// reconnecting afterwards does not make the studio scan a new QR. DELETE below
// is the destructive one.
router.post('/disconnect', async (req, res, next) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return undefined;

    const row = await loadInstance(orgId);
    if (!row) {
      return res.status(404).json({ success: false, code: 'NOT_CONNECTED', message: 'Not connected.' });
    }

    const result = await gateway.disconnect(orgId, row.instance_id, req.id);
    if (!result.ok) {
      return res.status(502).json({
        success: false,
        code: result.code || 'GATEWAY_UNREACHABLE',
        message: 'Could not reach the WhatsApp service.',
      });
    }

    await pool.query(
      `UPDATE whatsapp_instances
          SET status = 'disconnected', disconnected_at = NOW(), updated_at = NOW()
        WHERE instance_id = $1 AND organization_id = $2`,
      [row.instance_id, orgId]
    );
    return res.json({ success: true, state: 'disconnected' });
  } catch (err) {
    next(err);
    return undefined;
  }
});

// ── DELETE /api/integrations/whatsapp ───────────────────────────────────────
//
// Unlink completely: logs out of WhatsApp, destroys the session, removes the
// row. A new QR scan is required afterwards.
router.delete('/', async (req, res, next) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return undefined;

    const row = await loadInstance(orgId);
    if (!row) return res.json({ success: true });

    const result = await gateway.deleteInstance(orgId, row.instance_id, req.id);

    // A gateway that has already forgotten the instance (404) is the outcome
    // we wanted. Only a genuine failure blocks the local delete — otherwise a
    // studio could be permanently unable to unlink because a service it does
    // not know about is down.
    if (!result.ok && result.code !== 'INSTANCE_NOT_FOUND' && result.status !== 0) {
      return res.status(502).json({
        success: false,
        code: result.code || 'GATEWAY_ERROR',
        message: 'Could not reach the WhatsApp service.',
      });
    }

    await pool.query(
      `DELETE FROM whatsapp_instances WHERE instance_id = $1 AND organization_id = $2`,
      [row.instance_id, orgId]
    );
    logger.info({ org_id: orgId, operation: 'whatsapp.delete' }, 'whatsapp_instance_removed');
    return res.json({ success: true });
  } catch (err) {
    next(err);
    return undefined;
  }
});

module.exports = router;
