// src/routes/auth.js
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
// otplib v13 removed the `authenticator` singleton that v12 exported and
// replaced it with these functions. Verification now returns a RESULT OBJECT
// ({ valid, delta, ... }), not a boolean — reading it as a boolean would make
// every code appear valid, so the `.valid` property is checked explicitly.
// `epochTolerance` is in SECONDS; 30 is one TOTP step either side, matching
// what v12's `{ window: 1 }` meant.
const { verifySync } = require('otplib');
const pool   = require('../db/pool');
const devices = require('../modules/devices/devices.service');
const logger = require('../lib/logger');
const { auth, invalidateUserCache } = require('../middleware/auth');
const platformAuth = require('../middleware/platformAuth');
const { validate } = require('../middleware/validate');
const { authSchemas } = require('../lib/validation');
// Security Centre: one row per attempt. Fire-and-forget by design — see
// lib/loginEvents.js. Nothing below awaits it, and it cannot fail a login.
const loginEvents = require('../lib/loginEvents');
const {
  setAccessCookie, clearPortalCookies, clearLegacyCookies, signAccessToken,
  issueRefreshToken, bodyTokensAllowed, sessionUserPayload,
  requestPortal, portalCookieNames, legacyRefreshMatches,
} = require('../lib/authSession');
const { normalisePortal, portalProblem, portalForSession, resolveLoginPortal } = require('../lib/authPortal');
const recovery = require('../lib/mfaRecoveryCodes');
const { sendPasswordReset } = require('../lib/email');

// Compared against when the address is unknown. It is not a credential — no
// account has this password — only a real bcrypt hash, so a failed lookup
// costs the same work as a wrong password and response time stops revealing
// which addresses are registered. Built from the repo's locked placeholder
// rather than pasted: no credential-shaped constant is committed, and cost 12
// matches what a real password row costs to compare.
const DUMMY_PASSWORD_HASH = '$2a$12$' + '.'.repeat(53);

/** A stable, log-safe stand-in for an address: same address, same fingerprint. */
function emailFingerprint(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 12);
}

async function revokeRefreshToken(rawToken) {
  if (!rawToken) return null;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  // Read the owner before revoking: a retried logout (the first response was
  // lost) must still be able to revoke the device token, so an already-revoked
  // row must still identify its user. A failed UPDATE is not swallowed — the
  // route returns 500 and leaves the cookies alone rather than reporting a
  // logout that did not happen.
  const { rows } = await pool.query(
    'SELECT user_id FROM refresh_tokens WHERE token_hash = $1',
    [tokenHash]
  );
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1',
    [tokenHash]
  );
  return rows[0]?.user_id || null;
}

// Same shape the registration route accepts. A malformed value is ignored
// rather than failing the logout: signing out must not depend on push.
const FCM_TOKEN_RE = /^[A-Za-z0-9_:-]{20,4096}$/;

// POST /api/auth/login
router.post('/login', validate(authSchemas.login), async (req, res) => {
  try {
    const { email, password } = req.body;

    // ── Fetch user from DB ─────────────────────────────
    let rows;
    try {
      const result = await pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.password, u.token_version,
                u.trainer_id, u.member_id, u.pt_client_id, u.is_active,
                u.organization_id, o.name AS organization_name, o.logo_url AS organization_logo_url,
                -- Founder status rides along on the session rather than being
                -- fetched separately. The badge appears beside the studio name
                -- in the sidebar, on the dashboard, on every profile and team
                -- screen — six places that would otherwise each need their own
                -- request for two columns that change roughly once, ever.
                o.is_founder, o.founder_number,
                up.avatar_url
           FROM users u
           LEFT JOIN organizations o ON o.id = u.organization_id
           LEFT JOIN user_profiles up ON up.user_id = u.id
          WHERE LOWER(u.email) = LOWER($1) AND u.is_active = true
            AND u.deleted_at IS NULL`,
        [email]
      );
      rows = result.rows;
    } catch (dbErr) {
      logger.error({ err: dbErr.message }, 'Login DB error');
      return res.status(500).json({ error: 'Database connection error. Please try again.' });
    }

    const user = rows[0];
    if (!user) {
      // The query filters on is_active and deleted_at, so a missing row means
      // no such account, a deactivated one or a deleted one.
      //
      // deleted_at was missing here while middleware/auth.js filtered it. A
      // soft-deleted account with is_active still TRUE passed the password,
      // was handed a session, and had every request after it refused with
      // 401 — bounced back to the sign-in page, again and again, with nothing
      // saying why. They are recorded the same way
      // because the RESPONSE is the same — distinguishing them here would tell
      // an attacker which addresses are real.
      loginEvents.record(req, { outcome: loginEvents.OUTCOMES.UNKNOWN_USER, email });
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH).catch(() => {});
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // ── Verify password ────────────────────────────────
    let valid = false;
    try {
      valid = await bcrypt.compare(password, user.password);
    } catch (bcryptErr) {
      logger.error({ err: bcryptErr.message }, 'bcrypt error');
      return res.status(500).json({ error: 'Authentication error. Please try again.' });
    }

    if (!valid) {
      loginEvents.record(req, {
        outcome: loginEvents.OUTCOMES.BAD_PASSWORD, email,
        userId: user.id, orgId: user.organization_id,
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // ── Which door did they come through? ──────────────
    //
    // Two sign-in screens: Admin Login (/login) for the people who run a
    // studio, Member Login (/member-login) for clients. Each refuses the
    // other's accounts, and it is refused HERE rather than in the UI, because
    // a screen that merely looks separate is not separate at all — the same
    // POST works from either page, or from curl.
    //
    // ── Why this check sits AFTER the password ──
    //
    // Put it before, and the endpoint becomes an oracle: send any address with
    // a junk password and the difference between "invalid email or password"
    // and "this is the wrong sign-in page" tells an attacker the account
    // exists AND which side it is on. Running it here means the caller has
    // already proved they know the password, at which point their own role is
    // not a secret from them.
    //
    // Defaults to the trainer door when absent so every existing caller — the
    // mobile app on /api/v1/auth/login, a saved bookmark — behaves exactly as
    // it did. (validation.js has already normalised the legacy wire value
    // 'staff' to 'trainer'.)
    //
    // ── The third door ──
    //
    // 'platform' is the Command Center sign-in. It is a separate door for the
    // same reason the member one is: the screens merely LOOKING separate is
    // not separation, because the same POST works from either page or from
    // curl. What it adds over the other two is that the door now decides the
    // session's AUDIENCE — a token minted here may drive the control plane, a
    // token minted at the studio door may not, whatever role the account
    // holds. See middleware/platformAuth.js.
    const requestedPortal = normalisePortal(req.body.portal);
    const problem = portalProblem(user, requestedPortal);
    if (problem) {
      if (problem.code === 'ACCOUNT_MISCONFIGURED') {
        logger.error({ userId: user.id }, 'login refused: account role/tenant is misconfigured');
      } else {
        loginEvents.record(req, {
          outcome: loginEvents.OUTCOMES.WRONG_PORTAL, email,
          userId: user.id, orgId: user.organization_id,
        });
      }
      return res.status(problem.status).json({
        error: {
          code: problem.code,
          ...(problem.portal ? { portal: problem.portal } : {}),
          message: problem.message,
        },
      });
    }

    // ── 2FA enforcement for platform super admins ──────
    // A super_admin operates the whole platform, so their account MUST be
    // second-factor protected. If they have TOTP enabled, a valid 6-digit code
    // is required here. If they have not enrolled yet, login is allowed (so
    // they can reach Settings to set it up) but flagged mfaSetupRequired — the
    // platform API itself is blocked until 2FA is on (requireSuperAdminMfa).
    let mfaSetupRequired = false;
    if (user.role === 'super_admin') {
      let mfaEnabled = false;
      let mfaSecret = null;
      try {
        const { rows: mrows } = await pool.query(
          'SELECT mfa_enabled, mfa_secret FROM user_profiles WHERE user_id = $1', [user.id]
        );
        mfaEnabled = !!(mrows[0] && mrows[0].mfa_enabled);
        mfaSecret = mrows[0] && mrows[0].mfa_secret;
      } catch (mfaErr) {
        // user_profiles may not exist pre-migration — treat as not enrolled.
        logger.warn({ err: mfaErr.message }, 'super_admin mfa lookup failed');
      }
      if (mfaEnabled) {
        const code = String(req.body.mfa_code || '').trim();
        if (!code) {
          loginEvents.record(req, {
            outcome: loginEvents.OUTCOMES.MFA_REQUIRED, email,
            userId: user.id, orgId: user.organization_id,
          });
          return res.status(401).json({ error: 'MFA code required', mfaRequired: true });
        }
        // A 6-digit TOTP from the authenticator, OR a one-time recovery code
        // for the case these exist to cover: the authenticator is gone.
        //
        // Recovery codes were unusable before this. They were minted at
        // enrolment, never stored, and rejected here anyway because the only
        // accepted shape was /^\d{6}$/ — so the "get back into your account"
        // promise in the enrolment dialog could not be kept. redeem() spends
        // the code atomically (see lib/mfaRecoveryCodes.js); TOTP is tried
        // first so the ordinary path costs no extra query.
        const totp = /^\d{6}$/.test(code)
          ? verifySync({ secret: mfaSecret, token: code, strategy: 'totp', epochTolerance: 30 })
          : null;
        let mfaOk = Boolean(totp && totp.valid);
        // One use per code. A code stays valid for its whole step, so without
        // this a code seen once could be replayed to sign in again inside that
        // window (Command Center audit CC-8). The claim and the check are one
        // UPDATE: only a step newer than the last accepted one moves the
        // marker, so two concurrent logins with the same code cannot both win.
        if (mfaOk) {
          const step = Number(totp.timeStep);
          const claimed = Number.isFinite(step) && (await pool.query(
            `UPDATE user_profiles SET mfa_last_step = $2
              WHERE user_id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)`,
            [user.id, step]
          )).rowCount === 1;
          if (!claimed) {
            logger.warn({ userId: user.id }, 'mfa_code_replayed — a TOTP code was presented again inside its window');
            mfaOk = false;
          }
        }
        let usedRecoveryCode = false;
        if (!mfaOk && recovery.looksLikeRecoveryCode(code)) {
          mfaOk = await recovery.redeem(pool, user.id, code);
          usedRecoveryCode = mfaOk;
        }
        if (!mfaOk) {
          // A wrong second factor against a CORRECT password is the loudest
          // signal in this table: the password is already compromised.
          loginEvents.record(req, {
            outcome: loginEvents.OUTCOMES.MFA_FAILED, email,
            userId: user.id, orgId: user.organization_id,
          });
          return res.status(401).json({ error: 'Invalid MFA code', mfaRequired: true });
        }
        if (usedRecoveryCode) {
          // Worth a line of its own. Spending a recovery code means the
          // operator has lost their authenticator — or somebody else has a
          // printout. Either way it is the one login worth reading later,
          // and the remaining count is what says how close the account is to
          // having no way back in at all.
          const left = await recovery.remainingForUser(pool, user.id).catch(() => null);
          logger.warn(
            { userId: user.id, role: user.role, remaining: left },
            'mfa_recovery_code_used — second factor satisfied by a recovery code, not the authenticator'
          );
        }
      } else {
        mfaSetupRequired = true;
      }
    }

    // ── Update last login (non-critical, don't block on failure) ──
    pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])
      .catch(function(err) { logger.warn({ err: err.message }, 'last_login update failed (non-critical)'); });

    loginEvents.record(req, {
      outcome: loginEvents.OUTCOMES.SUCCESS, email,
      userId: user.id, orgId: user.organization_id,
    });

    // ── Sign JWT ───────────────────────────────────────
    // The audience is the door, not the role: an operator who signs in at the
    // studio door gets a tenant session and cannot drive the control plane
    // with it.
    const portal = resolveLoginPortal(user, requestedPortal);
    const audience = portal === 'platform'
      ? platformAuth.AUD_PLATFORM
      : platformAuth.AUD_TENANT;
    let token;
    try {
      token = signAccessToken(user.id, user.token_version, audience);
    } catch (jwtErr) {
      logger.error({ err: jwtErr.message }, 'JWT sign error');
      return res.status(500).json({ error: 'Token generation failed. Contact administrator.' });
    }

    setAccessCookie(res, portal, token, { mirrorLegacy: true });
    let refreshToken;
    try {
      refreshToken = await issueRefreshToken(res, user.id, audience, portal, { mirrorLegacy: true });
    } catch (rfErr) {
      logger.warn({ err: rfErr.message }, 'refresh_token issue failed (non-critical, table may not exist yet)');
    }

    // Web keeps using the httpOnly cookies set above and can ignore these
    // fields entirely. Mobile/native clients have no browser cookie jar, so
    // they read the tokens here, store them in secure on-device storage,
    // and send them back via `Authorization: Bearer <token>` (already
    // supported by the auth middleware) and a `refresh_token` body field.
    res.json({
      user: sessionUserPayload(user, { mfaSetupRequired }),
      ...(bodyTokensAllowed(req) ? { token, refresh_token: refreshToken } : {}),
    });

  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Unexpected login error');
    res.status(500).json({ error: 'Unexpected server error. Please try again.' });
  }
});

// POST /api/auth/logout
router.post('/logout', async function(req, res) {
  // Mobile clients have no refresh_token cookie to read — accept it from
  // the body as a fallback so they can revoke their session too.
  //
  // Only the named portal's session is revoked and cleared. The legacy pair is
  // cleared only when it is the mirror of that same session, so signing out of
  // one door cannot end another door's pre-migration session.
  const portal = requestPortal(req);
  const ownRefresh = portal ? req.cookies?.[portalCookieNames(portal).refresh] : null;
  const rawToken = (portal ? ownRefresh : req.cookies?.refresh_token) || req.body?.refresh_token;
  const deviceToken = typeof req.body?.device_token === 'string' ? req.body.device_token : null;
  const ownerId = await revokeRefreshToken(rawToken);

  // Revoke this device in the same request that ends the session. The web
  // client used to send DELETE /api/v1/devices alongside the logout and could
  // lose that race; a token that outlived its session kept alerting the
  // previous account. Ownership is checked against the refresh token's user,
  // so a caller cannot revoke somebody else's device by naming its token.
  if (ownerId && deviceToken && FCM_TOKEN_RE.test(deviceToken)) {
    try {
      await devices.revoke({ userId: ownerId, token: deviceToken, reason: 'logout' });
    } catch (err) {
      // A device-table failure must not trap the user in a session they asked
      // to end. The refresh token is already revoked, and FCM will retire the
      // token on its next send if the row survives.
      logger.warn({ err: err.message }, 'logout device revoke failed');
    }
  }

  clearPortalCookies(res, portal, {
    legacy: portal ? legacyRefreshMatches(req, portal) : true,
  });
  res.json({ message: 'Logged out' });
});

// POST /api/auth/refresh — exchange a valid refresh token for a new access token (token rotation)
router.post('/refresh', async (req, res) => {
  // The portal selects the cookie namespace. When it is named, only that
  // namespace is read first; the legacy pair is a migration fallback, and its
  // session is still checked against the named portal below.
  const requestedPortal = requestPortal(req);
  const names = requestedPortal ? portalCookieNames(requestedPortal) : null;
  const portalCookie = names ? req.cookies?.[names.refresh] : null;
  const legacyCookie = req.cookies?.refresh_token;

  let rawToken = portalCookie;
  let source = portalCookie ? 'portal' : null;
  if (!rawToken && legacyCookie) { rawToken = legacyCookie; source = 'legacy'; }
  if (!rawToken && req.body?.refresh_token) { rawToken = req.body.refresh_token; source = 'body'; }
  // Body tokens only for a cookieless, non-browser caller. A browser that has
  // lost its cookie but replays a refresh token from the body still gets
  // cookies only — see bodyTokensAllowed.
  const isMobile = source === 'body' && bodyTokensAllowed(req);
  if (!rawToken) return res.status(401).json({ error: 'No refresh token' });

  // Clear only what this request could have authenticated with. A failed
  // cross-portal probe must not clear the other portal's live session — and
  // the legacy pair is only one of the portals' mirror, so it is cleared only
  // when it was attributable to this door.
  const clearRejected = ({ legacy = source === 'legacy' } = {}) => {
    if (requestedPortal) clearPortalCookies(res, requestedPortal, { legacy });
    else if (legacy) clearLegacyCookies(res);
  };

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  try {
    // `audience` is selected so the refreshed session stays on the plane it
    // was opened for. Without it a refresh would launder the audience — a
    // studio-door session would come back fifteen minutes later as whatever
    // this handler chose to stamp, and the boundary would survive exactly one
    // token lifetime. Coalesced through a column check so this still runs on a
    // database that has not applied 162 (the value is then always NULL, i.e.
    // legacy, which is what such a database's sessions genuinely are).
    //
    // role and organization_id are here to place the session at its door:
    // trainer and member share the tenant audience, so the audience alone
    // cannot tell those two apart.
    let rows;
    try {
      ({ rows } = await pool.query(
        `SELECT rt.user_id, rt.audience, u.role, u.organization_id,
                u.token_version, u.is_active, u.deleted_at
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = $1
            AND rt.expires_at > NOW()
            AND rt.revoked_at IS NULL
          FOR UPDATE`,
        [tokenHash]
      ));
    } catch (err) {
      if (err && err.code === '42703') {
        ({ rows } = await pool.query(
          `SELECT rt.user_id, NULL::text AS audience, u.role, u.organization_id,
                  u.token_version, u.is_active, u.deleted_at
             FROM refresh_tokens rt
             JOIN users u ON u.id = rt.user_id
            WHERE rt.token_hash = $1
              AND rt.expires_at > NOW()
              AND rt.revoked_at IS NULL
            FOR UPDATE`,
          [tokenHash]
        ));
      } else {
        throw err;
      }
    }

    if (!rows[0] || !rows[0].is_active || rows[0].deleted_at) {
      clearRejected();
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const { user_id, token_version, audience } = rows[0];
    const tokenPortal = portalForSession(rows[0], audience ?? null);

    // A token minted at one door cannot be refreshed at another. The cookie
    // names already keep the namespaces apart; this catches a copied value.
    // The legacy mirror is not cleared here: it may belong to the door the
    // token actually came from, and a probe at the wrong door must not sign
    // that door out.
    if (requestedPortal && requestedPortal !== tokenPortal) {
      clearRejected({ legacy: false });
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const problem = portalProblem(rows[0], tokenPortal);
    if (problem) {
      clearRejected();
      return res.status(problem.status).json({
        error: {
          code: problem.code,
          ...(problem.portal ? { portal: problem.portal } : {}),
          message: problem.message,
        },
      });
    }

    // Rotate: claim the old token, then issue new ones.
    //
    // The claim is the UPDATE, not the SELECT above. That SELECT's FOR UPDATE
    // runs on an autocommitted pool.query, so its lock is released before this
    // line — two requests presenting the same token both passed it, and both
    // were issued a fresh pair. `AND revoked_at IS NULL` makes exactly one of
    // them win; the loser gets the same 401 as an already-used token, so a
    // replayed refresh token can never fork into two live sessions.
    const claim = await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash]
    );
    if (claim.rowCount !== 1) {
      clearRejected();
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Never downgrade a platform session: the portal decides the audience, and
    // a legacy null audience is upgraded to tenant only for a tenant door.
    const newAudience = tokenPortal === 'platform'
      ? platformAuth.AUD_PLATFORM
      : platformAuth.AUD_TENANT;
    const mirrorLegacy = source !== 'portal'
      || !!(requestedPortal && legacyRefreshMatches(req, requestedPortal));

    const newAccessToken = signAccessToken(user_id, token_version, newAudience);
    setAccessCookie(res, tokenPortal, newAccessToken, { mirrorLegacy });
    const newRefreshToken = await issueRefreshToken(res, user_id, newAudience, tokenPortal, { mirrorLegacy });

    res.json(isMobile ? { ok: true, token: newAccessToken, refresh_token: newRefreshToken } : { ok: true });
  } catch (err) {
    logger.error({ err: err.message }, 'Token refresh error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    // btrim on BOTH sides. A stored address with a stray leading or trailing
    // space — easy to introduce when an operator pastes one into the admin UI
    // — would never match, and the request would then look exactly like a
    // broken mailer: the caller is told a link was sent, and nothing is sent.
    const { rows } = await pool.query(
      // deleted_at: a deleted account gets no reset link — resetting it would
      // only lead to a sign-in the rest of the app refuses.
      'SELECT id FROM users WHERE btrim(LOWER(email)) = btrim(LOWER($1)) AND deleted_at IS NULL',
      [email]
    );

    // Every outcome is logged server-side, because until now one of them was
    // not logged at all. A request for an address with no user did nothing and
    // said nothing — indistinguishable in the logs from SMTP being down, while
    // the caller saw the same reassuring message either way. That is the state
    // "password reset emails are not arriving" is reported from, and there was
    // no way to tell which of the two it was.
    //
    // The RESPONSE is deliberately unchanged: it must not reveal whether an
    // address is registered. The logs are operator-only and can be honest.
    // Fingerprints, never addresses: the logs are operator-only, but an email
    // address is still PII and a log file is still a copy of it.
    const fingerprint = emailFingerprint(email);
    if (!rows.length) {
      logger.warn({ email_fingerprint: fingerprint, outcome: 'unknown_address' },
        'Password reset requested for an address with no user account — nothing sent');
    } else {
      await pool.query(
        // M-07: 15-minute window — was 1 hour, which gave too large an interception window
      'UPDATE users SET password_reset_token = $1, password_reset_expires = NOW() + INTERVAL \'15 minutes\' WHERE id = $2',
        [hashedToken, rows[0].id]
      );
      sendPasswordReset(email, rawToken)
        .then(function(result) {
          if (result && result.sent === false) {
            logger.error({ email_fingerprint: fingerprint, outcome: 'smtp_not_configured' },
              'Password reset email NOT sent: SMTP is not configured on this deploy');
          } else {
            logger.info({ email_fingerprint: fingerprint, outcome: 'sent' }, 'Password reset email sent');
          }
        })
        .catch(function(err) {
          logger.error({ email_fingerprint: fingerprint, outcome: 'send_failed', err: err.message },
            'Password reset email failed to send');
        });
    }

    // Always return success — don't reveal if email exists
    res.json({ message: 'If the email exists, a reset link has been sent.' });
  } catch (err) {
    logger.error({ err: err.message }, 'Forgot password error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const { rows } = await pool.query(
      `SELECT id FROM users
        WHERE password_reset_token = $1 AND password_reset_expires > NOW()
          AND deleted_at IS NULL`,
      [hashedToken]
    );

    if (!rows.length) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hashed = await bcrypt.hash(password, 12);
    // AUD-005. Bumping token_version kills the 15-minute ACCESS tokens, but
    // refresh tokens live in their own table and /refresh never consults
    // token_version — so without this, a stolen refresh token keeps minting new
    // access tokens for the remaining 7 days, and rotation renews it each time.
    //
    // One statement, not two: the password write and the revocation have to
    // succeed or fail together. If the revoke were a second query and it failed,
    // the password would already have changed and the attacker's session would
    // survive — exactly the bug this closes. A data-modifying CTE gives that
    // atomicity without introducing transaction management into a handler that
    // has never had any.
    await pool.query(
      `WITH pw AS (
         UPDATE users
            SET password = $1,
                token_version = token_version + 1,
                password_reset_token = NULL,
                password_reset_expires = NULL,
                updated_at = NOW()
          WHERE id = $2
         RETURNING id
       )
       UPDATE refresh_tokens
          SET revoked_at = NOW()
        WHERE user_id = (SELECT id FROM pw)
          AND revoked_at IS NULL`,
      [hashed, rows[0].id]
    );
    invalidateUserCache(rows[0].id);

    res.json({ message: 'Password reset successfully. Please log in with your new password.' });
  } catch (err) {
    logger.error({ err: err.message }, 'Reset password error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', (req, res, next) => {
  // A caller holding neither cookie is a visitor, not an expired session.
  // Answering 401 sent the app's 401 → refresh → retry path on every landing
  // page visit, and the failed refresh then fired the "session expired"
  // handler at somebody who was never signed in. A refresh cookie that is
  // still present is the case that genuinely needs the 401, because that is
  // what makes the app refresh and retry.
  //
  // Per portal: another portal's session is not this portal's session. A
  // member visiting the studio's landing page must not be treated as an
  // expired trainer. The legacy pair gets `legacy: true` instead of a 401 so
  // the app can perform the one-time migration without signing anybody out.
  const portal = requestPortal(req);
  if (portal) {
    const n = portalCookieNames(portal);
    const own = req.cookies?.[n.access] || req.cookies?.[n.refresh];
    if (!own) {
      if (req.cookies?.token || req.cookies?.refresh_token) return res.json({ user: null, legacy: true });
      return res.json({ user: null });
    }
  } else if (!req.cookies?.token && !req.cookies?.refresh_token) {
    return res.json({ user: null });
  }
  next();
}, auth, (req, res) => {
  res.json({ user: req.user });
});

// PUT /api/auth/change-password
// Also accepts POST for backwards compatibility with older frontend builds
async function changePasswordHandler(req, res) {
  try {
    // Accept both new and legacy field names so a stale frontend still works
    const currentPassword = (
      req.body.currentPassword ?? req.body.current ?? req.body.oldPassword ?? ''
    ).trim();
    const newPassword = (
      req.body.newPassword ?? req.body.newPw ?? req.body.password ?? ''
    ).trim();

    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Both current and new password are required' });
    // L-03: standardise to 8 chars minimum across all password flows
    if (typeof newPassword !== 'string' || newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const { rows } = await pool.query(
      'SELECT password FROM users WHERE id = $1', [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, rows[0].password);
    // 400, not 401. The caller IS authenticated — they mistyped a form field.
    // A 401 here made the frontend's session layer refresh the token, retry,
    // get 401 again and sign the user out: one typo on "current password"
    // ended the session of the person trying to secure it.
    if (!valid) {
      return res.status(400).json({
        error: { code: 'WRONG_CURRENT_PASSWORD', message: 'Current password is incorrect' },
      });
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    // AUD-005, the change-password half. Same revocation as reset-password, but
    // the contract here is different and deliberately so: this handler keeps the
    // caller signed in (it sets a fresh access cookie and issues a replacement
    // refresh token below). So every OTHER session dies and the caller's does
    // not — which is why the revoke happens HERE, before issueRefreshToken(),
    // rather than after it. Reversed, it would sign the user out of the very
    // browser they just changed their password in.
    //
    // This replaces the previous single-token revoke, which only killed the
    // refresh token presented in the caller's own cookie and left every other
    // device signed in with the old password's session. It also now covers
    // mobile clients, which send the token in the body rather than a cookie.
    //
    // RETURNING folds in the follow-up SELECT the old code needed, so the
    // token_version stamped into the new JWT is the one this statement wrote —
    // no window in which a concurrent bump could be missed.
    const { rows: updated } = await pool.query(
      `WITH pw AS (
         UPDATE users
            SET password = $1,
                token_version = token_version + 1,
                updated_at = NOW()
          WHERE id = $2
         RETURNING id, token_version
       ), revoked AS (
         UPDATE refresh_tokens
            SET revoked_at = NOW()
          WHERE user_id = (SELECT id FROM pw)
            AND revoked_at IS NULL
       )
       SELECT token_version FROM pw`,
      [hashed, req.user.id]
    );
    invalidateUserCache(req.user.id);
    // Same plane the caller is already on. Changing a password must not move a
    // session between the control plane and the tenant app in either
    // direction — silently upgrading one here would be a privilege escalation
    // reachable from a password form, and silently downgrading it would sign
    // the operator out of the console for changing their password.
    const sessionAud = platformAuth.sessionAudience(req);
    const portal = portalForSession(req.user, sessionAud);
    const mirrorLegacy = legacyRefreshMatches(req, portal);
    const newToken = signAccessToken(req.user.id, updated[0].token_version, sessionAud);
    setAccessCookie(res, portal, newToken, { mirrorLegacy });
    // The caller's old refresh token was revoked by the statement above, along
    // with every other session's. This issues the replacement that keeps THIS
    // browser signed in.
    try { await issueRefreshToken(res, req.user.id, sessionAud, portal, { mirrorLegacy }); } catch { /* non-critical */ }
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    logger.error({ err: err.message }, 'Change password error');
    res.status(500).json({ error: 'Server error' });
  }
}
router.put('/change-password', auth, validate(authSchemas.changePassword), changePasswordHandler);
router.post('/change-password', auth, validate(authSchemas.changePassword), changePasswordHandler);

// The legacy account-management endpoints (/create-user, /users, /users/:id,
// /users/:id/toggle) are gone. They were super_admin-only duplicates of the
// Command Center's user management (/api/platform/users, /organizations), and
// with the tenant boundary strict they could only ever match nothing — while
// still letting the operator create super_admin accounts outside the
// platform-grant flow and change any login's role. A studio's trainer is
// created with the studio, and its members by client activation.

module.exports = router;
