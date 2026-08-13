'use strict';
// Read-only impersonation sessions — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const crypto = require('crypto');
const router = require('express').Router();
const {
  IMPERSONATION_TTL, audit, jwt, pool,
} = require('./shared');
// ── POST /organizations/:id/impersonate ───────────────────────────────────────
// Mint a short-lived, READ-ONLY access token for a studio's admin so the operator
// can enter the workspace and see exactly what that admin sees. The token carries
// an `imp` claim; the auth middleware loads the target admin as req.user (so the
// whole app renders as them) and rejects every write while `imp.ro` is set. The
// operator's own super-admin session is untouched — the client sends this token
// via Authorization header and simply drops it to exit. No refresh token issued.
router.post('/organizations/:id/impersonate', async (req, res, next) => {
  try {
    const { rows: orgs } = await pool.query(
      'SELECT id, name, slug, logo_url, status FROM organizations WHERE id = $1', [req.params.id]
    );
    if (!orgs.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    const org = orgs[0];

    // Target: an explicit user in this org, else the studio's primary admin.
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
          WHERE organization_id = $1 AND role = 'admin' AND deleted_at IS NULL
          ORDER BY is_active DESC, created_at ASC LIMIT 1`,
        [org.id]
      );
      target = rows[0];
    }

    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No admin account to impersonate in this studio' } });
    if (target.role === 'super_admin') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot impersonate a platform account' } });
    if (!target.is_active) return res.status(409).json({ error: { code: 'INACTIVE', message: 'That account is deactivated' } });

    // Mode: read-only by default (safe). 'full' allows writes as the admin — every
    // audited write during that window is stamped with who really acted
    // (_impersonated_by) by the shared activity logger.
    const readonly = req.body.mode !== 'full';

    // jti identifies THIS impersonation session, so the start event, every
    // audited write inside it, and the end event can be stitched into one
    // sequence afterwards — otherwise two sessions into the same studio in one
    // afternoon are indistinguishable in the log.
    //
    // It also leaves the door open to real revocation later (a deny-list keyed
    // on this id) without re-minting the token design. Not implemented now, and
    // deliberately: the token already expires in IMPERSONATION_TTL, and a
    // revocation store is a subsystem, not a line.
    const jti = crypto.randomUUID();

    const token = jwt.sign(
      {
        id: target.id,
        token_version: target.token_version,
        jti,
        imp: { by: req.user.id, byName: req.user.name || 'Admin', ro: readonly, org: org.id, jti },
      },
      process.env.JWT_SECRET,
      { expiresIn: IMPERSONATION_TTL }
    );

    await audit(req, 'user_impersonated', 'user', target.id, { organization_id: org.id, readonly, mode: readonly ? 'read_only' : 'full', jti });
    res.json({
      data: {
        token,
        readonly,
        jti,
        admin: { id: target.id, name: target.name, email: target.email, role: target.role },
        organization: { id: org.id, name: org.name, slug: org.slug, logo_url: org.logo_url },
      },
    });
  } catch (err) { next(err); }
});

// ── POST /impersonation/end ───────────────────────────────────────────────────
// Close an impersonation session, on the record.
//
// Until this existed, exiting was purely a client-side act: the browser dropped
// the token out of sessionStorage and that was that. The log therefore showed
// every entry into a studio and no exit from any of them, so "when did the
// operator stop acting inside this studio" had no answer — only "the token
// would have expired by now, at the latest".
//
// This is reached with the operator's OWN super-admin cookie session, which was
// never replaced (the impersonation token rides as a Bearer on top of it), so it
// inherits this router's auth -> requireSuperAdmin -> requireSuperAdminMfa mount
// like every other platform route. The client must NOT send the impersonation
// Bearer here — that identity is a studio admin and would be refused by
// requireSuperAdmin, which is the correct outcome for the wrong reason.
//
// What this deliberately does NOT do is invalidate the token. It is a stateless
// JWT; killing it needs a revocation store, which is a subsystem rather than a
// line, and the token is already short-lived. So this records the end of the
// session, and the ceiling on a token that outlives its recorded end is
// IMPERSONATION_TTL — the same ceiling that existed before.
router.post('/impersonation/end', async (req, res, next) => {
  try {
    const { organization_id: orgId, admin_id: adminId, jti, reason } = req.body || {};

    await audit(req, 'user_impersonation_ended', 'user', adminId || null, {
      organization_id: orgId || null,
      jti: jti || null,
      // 'expired' when the client noticed the token die, 'manual' when somebody
      // pressed Exit. The difference is worth keeping: a session that always
      // ends by expiry means operators are not exiting deliberately.
      reason: reason === 'expired' ? 'expired' : 'manual',
    });

    res.json({ data: { ended: true } });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION / BILLING MANAGEMENT (platform operator)
// ══════════════════════════════════════════════════════════════════════════════


module.exports = router;
