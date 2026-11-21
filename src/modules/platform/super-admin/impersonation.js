'use strict';
// Impersonation sessions — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.
//
// ── What changed with migration 285 ────────────────────────────────────────
//
// The mint used to produce a bare JWT: no session row, no reason, no way to
// end it early. This file now creates an `impersonation_sessions` row, embeds
// its id in the token (`imp.sid`), and exposes list / end / revoke / actions.
// auth.js checks the row on every request, so ending or revoking a session
// takes effect immediately instead of at the token's TTL.

const crypto = require('crypto');
const router = require('express').Router();
const {
  IMPERSONATION_TTL, audit, jwt, pool,
} = require('./shared');
const { AUD_TENANT } = require('../../../middleware/platformAuth');

const REASON_MIN = 3;
const REASON_MAX = 500;
const MAX_LIST = 100;

function cleanReason(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}

function sessionView(row) {
  return {
    id: row.id,
    mode: row.mode,
    readonly: row.mode === 'read_only',
    reason: row.reason,
    started_at: row.started_at,
    expires_at: row.expires_at,
    ended_at: row.ended_at,
    end_reason: row.end_reason,
    revoked_at: row.revoked_at,
    active: row.ended_at == null && new Date(row.expires_at).getTime() > Date.now(),
    operator: { id: row.operator_id, name: row.operator_name || null, email: row.operator_email || null },
    account: { id: row.target_user_id, name: row.target_name || null, email: row.target_email || null },
    organization: { id: row.organization_id, name: row.organization_name || null, slug: row.organization_slug || null },
    ip: row.ip || null,
    user_agent: row.user_agent || null,
    action_count: Number(row.action_count || 0),
  };
}

const SESSION_SELECT = `
  SELECT s.*,
         op.name AS operator_name, op.email AS operator_email,
         tu.name AS target_name, tu.email AS target_email,
         o.name AS organization_name, o.slug AS organization_slug,
         (SELECT count(*) FROM impersonation_session_actions a WHERE a.session_id = s.id) AS action_count
    FROM impersonation_sessions s
    LEFT JOIN users op ON op.id = s.operator_id
    LEFT JOIN users tu ON tu.id = s.target_user_id
    LEFT JOIN organizations o ON o.id = s.organization_id
`;

// ── POST /organizations/:id/impersonate ───────────────────────────────────────
// Mint a short-lived access token for a studio's account so the operator can
// enter the workspace and see exactly what that account sees. The token carries
// an `imp` claim naming both the session row (`sid`) and its mode; auth.js loads
// the target account as req.user (so the whole app renders as them) and checks
// the session row on every request.
//
// The operator's own super-admin session is untouched — the client sends this
// token via Authorization header and simply drops it to exit. No refresh token
// is issued, so the TTL is still a hard ceiling; the session row adds early
// revocation on top of it.
router.post('/organizations/:id/impersonate', async (req, res, next) => {
  try {
    const reason = cleanReason(req.body && req.body.reason);
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      return res.status(400).json({
        error: {
          code: 'REASON_REQUIRED',
          message: `Give a reason for entering this studio (${REASON_MIN}–${REASON_MAX} characters). It is stored with the session.`,
        },
      });
    }

    const { rows: orgs } = await pool.query(
      'SELECT id, name, slug, logo_url, status FROM organizations WHERE id = $1', [req.params.id]
    );
    if (!orgs.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    const org = orgs[0];

    // Target: an explicit account in this org, else the studio's trainer.
    let target;
    if (req.body.user_id) {
      const { rows } = await pool.query(
        `SELECT id, name, email, role, token_version, is_active FROM users
          WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [req.body.user_id, org.id]
      );
      target = rows[0];
    } else {
      const { rows } = await pool.query(
        `SELECT id, name, email, role, token_version, is_active FROM users
          WHERE organization_id = $1 AND role = 'trainer' AND deleted_at IS NULL
          ORDER BY is_active DESC, created_at ASC LIMIT 1`,
        [org.id]
      );
      target = rows[0];
    }

    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No trainer account to impersonate in this studio' } });
    if (target.role === 'super_admin') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot impersonate a platform account' } });
    if (!target.is_active) return res.status(409).json({ error: { code: 'INACTIVE', message: 'That account is deactivated' } });

    // Mode: read-only by default (safe). 'full' allows writes as the account — every
    // audited write during that window is stamped with who really acted
    // (_impersonated_by) by the shared activity logger, and the transport-level
    // action is recorded in impersonation_session_actions.
    const readonly = req.body.mode !== 'full';
    const mode = readonly ? 'read_only' : 'full';

    // Ten minutes to two hours, clamped by shared.js. Parsed here so the row's
    // expires_at is the same instant the JWT carries.
    const ttlMs = (() => {
      const m = String(IMPERSONATION_TTL).match(/^(\d+)m$/);
      return (m ? Number(m[1]) : 30) * 60 * 1000;
    })();
    const expiresAt = new Date(Date.now() + ttlMs);
    const jti = crypto.randomUUID();

    const { rows: created } = await pool.query(
      `INSERT INTO impersonation_sessions
         (operator_id, target_user_id, organization_id, mode, reason, jti, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, started_at, expires_at`,
      [
        req.user.id, target.id, org.id, mode, reason, jti,
        req.ip || null, req.get('user-agent') || null, expiresAt,
      ]
    );
    const session = created[0];

    // TENANT audience, deliberately — this is the operator's sanctioned way
    // INTO a studio, so the token it mints must be a studio token.
    //
    // It is also what makes impersonation the ONLY way in once
    // PLATFORM_SESSION_ENFORCE is on: the operator's own platform session is
    // refused by the tenant app (denyPlatformSession), and this one is refused
    // by the control plane (requirePlatformOwner rejects any request carrying
    // `imp`). Neither token can do both jobs, so every crossing between the
    // planes goes through this handler — which writes the audit row below.
    const token = jwt.sign(
      {
        id: target.id,
        token_version: target.token_version,
        aud: AUD_TENANT,
        jti,
        imp: {
          by: req.user.id,
          byName: req.user.name || 'Platform operator',
          ro: readonly,
          org: org.id,
          sid: session.id,
          rsn: reason.slice(0, 120),
        },
      },
      process.env.JWT_SECRET,
      { expiresIn: IMPERSONATION_TTL }
    );

    await audit(req, 'user_impersonated', 'user', target.id, {
      organization_id: org.id,
      readonly,
      mode,
      session_id: session.id,
      reason,
      expires_at: session.expires_at,
    });

    res.json({
      data: {
        token,
        readonly,
        // The account being acted as — the studio's trainer unless the
        // operator named another. (Was `admin`, from before the studio's
        // owner was its trainer.)
        account: { id: target.id, name: target.name, email: target.email, role: target.role },
        organization: { id: org.id, name: org.name, slug: org.slug, logo_url: org.logo_url },
        session: {
          id: session.id,
          reason,
          mode,
          started_at: session.started_at,
          expires_at: session.expires_at,
        },
      },
    });
  } catch (err) { next(err); }
});

// ── GET /impersonation/sessions ────────────────────────────────────────────
// The console's "who is inside a studio right now" and its session history.
router.get('/impersonation/sessions', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'all');
    if (!['all', 'active', 'ended'].includes(status)) {
      return res.status(400).json({ error: { code: 'INVALID_STATUS', message: 'status must be all, active or ended' } });
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), MAX_LIST);
    const params = [];
    const where = [];

    if (status === 'active') {
      where.push('s.ended_at IS NULL AND s.expires_at > now()');
    } else if (status === 'ended') {
      where.push('(s.ended_at IS NOT NULL OR s.expires_at <= now())');
    }
    if (req.query.organization_id) {
      params.push(req.query.organization_id);
      where.push(`s.organization_id = $${params.length}`);
    }
    if (req.query.operator_id) {
      params.push(req.query.operator_id);
      where.push(`s.operator_id = $${params.length}`);
    }
    params.push(limit);

    const { rows } = await pool.query(
      `${SESSION_SELECT}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.started_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ data: rows.map(sessionView) });
  } catch (err) { next(err); }
});

// ── GET /impersonation/sessions/:id/actions ────────────────────────────────
// Transport-level writes made during a full-access session. Read-only
// sessions cannot write, so this is empty for them by construction.
router.get('/impersonation/sessions/:id/actions', async (req, res, next) => {
  try {
    const { rows: sessions } = await pool.query(
      'SELECT id FROM impersonation_sessions WHERE id = $1', [req.params.id]
    );
    if (!sessions.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { rows } = await pool.query(
      `SELECT id, method, path, status_code, at
         FROM impersonation_session_actions
        WHERE session_id = $1
        ORDER BY at DESC
        LIMIT $2`,
      [req.params.id, limit]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /impersonation/sessions/:id/end ───────────────────────────────────
// The banner's Exit. The operator's own platform session authorizes this, not
// the impersonation token (which cannot reach the control plane). Idempotent:
// pressing Exit twice, or after the TTL elapsed, is a success rather than an
// error the UI has to explain.
router.post('/impersonation/sessions/:id/end', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE impersonation_sessions
          SET ended_at = COALESCE(ended_at, now()),
              end_reason = COALESCE(end_reason, 'operator_exit')
        WHERE id = $1 AND operator_id = $2
        RETURNING id, ended_at, end_reason`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    }
    await audit(req, 'impersonation_ended', 'impersonation_session', rows[0].id, {
      end_reason: rows[0].end_reason,
    });
    res.json({ data: { id: rows[0].id, ended_at: rows[0].ended_at, end_reason: rows[0].end_reason } });
  } catch (err) { next(err); }
});

// ── POST /impersonation/sessions/:id/revoke ────────────────────────────────
// Any platform owner may revoke any session, including one they did not start.
// This is the "kick the operator out" control; the next request with that
// token fails closed in auth.js.
router.post('/impersonation/sessions/:id/revoke', async (req, res, next) => {
  try {
    const reason = cleanReason(req.body && req.body.reason) || 'Revoked from the Command Center';
    const { rows } = await pool.query(
      `UPDATE impersonation_sessions
          SET ended_at = COALESCE(ended_at, now()),
              end_reason = COALESCE(end_reason, 'revoked'),
              revoked_at = COALESCE(revoked_at, now()),
              revoked_by = $2
        WHERE id = $1
        RETURNING id, ended_at, end_reason, revoked_at`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    }
    await audit(req, 'impersonation_revoked', 'impersonation_session', rows[0].id, { reason });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION / BILLING MANAGEMENT (platform operator)
// ══════════════════════════════════════════════════════════════════════════════


module.exports = router;
