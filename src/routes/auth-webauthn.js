// src/routes/auth-webauthn.js
// WebAuthn / Passkey authentication for staff (admin, manager, trainer, reception).
// Mounted at /api/auth/webauthn by server.js
// Uses @simplewebauthn/server v13 API.
//
// Separate from /api/webauthn (member biometric check-in via webauthn.js).
// This route uses user_webauthn_credentials (user_id FK to users table).

'use strict';
const express  = require('express');
const jwt      = require('jsonwebtoken');
const pool     = require('../db/pool');
const { auth } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');
const logger   = require('../lib/logger');
const loginEvents = require('../lib/loginEvents');
const { AUD_TENANT } = require('../middleware/platformAuth');
const rateLimit = require('express-rate-limit');
const { makeStore } = require('../lib/rateLimitStore');

const router = express.Router();

const authnLimiter = rateLimit({
  store: makeStore('webauthn'),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please wait 15 minutes.' },
});

const RP_NAME = process.env.RP_NAME || 'MY PT STUDIO';
const isProd  = process.env.NODE_ENV === 'production';

// ── rpId and expectedOrigin ─────────────────────────────────────────────────
//
// These two values decide whether passkeys work at all, and getting either
// wrong fails in the most unhelpful way available: /register/options returns
// 200, a challenge lands in the database, and the BROWSER refuses — so the
// server sees a perfectly healthy request and the user sees nothing happen.
//
// The rule the browser enforces is fixed: rpId must equal the page's hostname
// or be a registrable suffix of it. Nothing else is negotiable, which means a
// stale RP_ID is not a preference to honour — it is a guaranteed outage. This
// used to return process.env.RP_ID unconditionally, so a value left pointing at
// a previous domain (a rebrand, a second client, a moved deployment) broke
// every enrolment with no error anywhere on this side.

/**
 * Raised when neither the env vars nor the request headers can tell us which
 * domain this instance serves, so no honest WebAuthn ceremony is possible.
 * Carries its own HTTP shape because the generic error handler would render it
 * as an opaque 500 — and an opaque 500 is exactly the failure mode this is
 * here to eliminate.
 */
class WebAuthnConfigError extends Error {
  constructor(what) {
    super(
      `WebAuthn is not configured on this deployment: cannot determine the ${what}. ` +
      'Set RP_ID to the bare domain the frontend is served from (no scheme, no port) ' +
      'and WEBAUTHN_ORIGIN to its full origin, then redeploy. ' +
      'Both are per-deployment values and are intentionally not in the repo.'
    );
    this.name = 'WebAuthnConfigError';
    this.status = 503;
    this.code = 'WEBAUTHN_NOT_CONFIGURED';
  }
}

/**
 * Wraps a route so a WebAuthnConfigError becomes its own 503 with an
 * actionable message instead of falling through to the generic handler.
 *
 * Intercepts BOTH exits, because every route in this file already wraps its
 * body in `try { … } catch (err) { next(err) }`. That inner catch swallows the
 * throw before it can reach this function, so catching alone never fires — the
 * error reaches the app's generic handler and renders as an opaque 500, which
 * is precisely the failure mode this exists to replace. Hence the wrapped
 * `next`: it is the path that actually runs, and the try/catch is the backstop
 * for any future route that lets an error escape instead.
 */
function withConfigCheck(handler) {
  return async function configChecked(req, res, next) {
    const render = (err) => {
      logger.error({ code: err.code }, err.message);
      return res.status(err.status).json({ error: err.message, code: err.code });
    };
    const guardedNext = (err) =>
      (err instanceof WebAuthnConfigError ? render(err) : next(err));

    try {
      return await handler(req, res, guardedNext);
    } catch (err) {
      if (err instanceof WebAuthnConfigError) return render(err);
      return next(err);
    }
  };
}

/**
 * WebAuthn's registrable-suffix test.
 *
 * Not endsWith: 'fitnessstudio.com' must NOT match 'my619fitnessstudio.com',
 * so the boundary has to be a literal dot. (The public-suffix rule that also
 * forbids rpId='com' is enforced by the browser; this only has to agree with
 * it on the cases that reach us.)
 */
function isRegistrableSuffix(rpId, hostname) {
  if (!rpId || !hostname) return false;
  if (rpId === hostname) return true;
  return hostname.endsWith(`.${rpId}`);
}

/**
 * The hostname the browser is actually looking at, whatever route the request
 * took to reach this process.
 *
 * Origin first: a same-origin POST carries it, and it is the browser's own
 * account of the page. x-forwarded-host second, for proxies that drop Origin —
 * Vercel's rewrite and nginx both set it to the client-facing host. Host last.
 */
function requestHostname(req) {
  const trusted = trustedHostname(req);
  if (trusted) return trusted;
  const candidate = req.headers.host;
  if (candidate) {
    const host = String(candidate).split(',')[0].trim().replace(/:\d+$/, '');
    if (host) return host;
  }
  return null;
}

/**
 * The same, from a source we can trust to reflect the browser's own page
 * rather than a hop in between — Origin, or x-forwarded-host for a proxy
 * that dropped it.
 *
 * Deliberately excludes the bare Host header that requestHostname() falls
 * back to. Host is not the browser's account of anything — it is whatever
 * the connecting socket or an intermediate hop happened to send, which on
 * many topologies is an internal address or a load balancer's own name.
 * getEffectiveRpId() uses this, not requestHostname(), to decide whether a
 * CONFIGURED RP_ID should be rejected: rejecting a correctly configured
 * value because it does not match Host would refuse legitimate traffic on
 * any topology where Host is not the public-facing domain — exactly the
 * failure mode a direct-to-backend health check or this file's own
 * integration tests hit, and a real regression the first version of this
 * change shipped with.
 */
function trustedHostname(req) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const { hostname } = new URL(origin);
      if (hostname) return hostname;
    } catch { /* malformed Origin — fall through to the forwarded header */ }
  }
  const fwdHost = req.headers['x-forwarded-host'];
  if (fwdHost) {
    const host = String(fwdHost).split(',')[0].trim().replace(/:\d+$/, '');
    if (host) return host;
  }
  return null;
}

/** Full scheme://host the browser used, reconstructed if the proxy dropped Origin. */
function requestOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).origin; } catch { /* fall through */ }
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return null;
  const h = String(host).split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http'))
    .split(',')[0].trim();
  return h ? `${proto}://${h}` : null;
}

/**
 * FRONTEND_URL's hostname — the domain this API exists to serve.
 *
 * This is the fallback rpId rather than the request's hostname, and the
 * distinction matters: a request header is chosen by whoever is calling, so
 * deriving the rpId from one lets any origin that can reach this route decide
 * which domain a credential gets minted for. FRONTEND_URL is required config
 * (server.js refuses to boot without it), so it is always available and it is
 * never the caller's to set.
 */
function frontendHostname() {
  const raw = String(process.env.FRONTEND_URL || '').split(',')[0].trim();
  if (!raw) return null;
  try { return new URL(raw).hostname || null; } catch { return null; }
}

function getEffectiveRpId(req) {
  const hostname = trustedHostname(req);
  const configured = process.env.RP_ID;

  // Honoured whenever the browser could actually accept it.
  if (configured && (!hostname || isRegistrableSuffix(configured, hostname))) return configured;

  // Either RP_ID is unset, or it is set to a value this host cannot use — a
  // value left pointing at a previous domain after a rebrand or a move, which
  // fails in the one way nothing here can see: /register/options returns 200,
  // the challenge is written, and the browser refuses.
  const frontend = frontendHostname();

  if (configured) {
    logger.error(
      { configured, requestHostname: hostname, frontendHostname: frontend },
      'RP_ID is not a registrable suffix of the requesting host, so passkey enrolment '
      + 'from that host fails in the browser with SecurityError. Falling back to '
      + "FRONTEND_URL's hostname — set RP_ID to the domain the app is served from."
    );
  }

  if (frontend) return frontend;

  // No FRONTEND_URL (impossible in production; server.js exits at boot without
  // it). Only now is the request worth reading, and only to keep local
  // development working — requestHostname() here (not trustedHostname()),
  // since nothing is being rejected at this point and the bare Host header
  // is better than nothing for a local dev server with no proxy in front.
  const derived = requestHostname(req);
  if (derived && derived !== 'localhost' && !derived.startsWith('127.')) {
    logger.warn({ hostname: derived }, 'WebAuthn rpId derived from the request — set RP_ID and FRONTEND_URL');
    return derived;
  }

  // Reached only when RP_ID is unset or rejected AND FRONTEND_URL is
  // unusable AND the request carries no usable host — the pathological case,
  // since server.js already refuses to boot in production without
  // FRONTEND_URL set. Failing loudly here is still cheaper than a silent 200:
  // rpId='localhost' served to a browser on a real domain makes
  // navigator.credentials.create() throw SecurityError client-side, with
  // nothing logged server-side and no row written anywhere. The ceremony dies
  // between /options and /verify, leaving only an orphaned challenge,
  // indistinguishable from a user who changed their mind.
  if (isProd) throw new WebAuthnConfigError('rpId');

  logger.warn('No usable RP_ID, FRONTEND_URL or request host — falling back to localhost');
  return 'localhost';
}

/**
 * Every origin we will accept, given one we already trust — the origin itself
 * plus its `www`-toggled sibling.
 *
 * This exists because of a real failure. WEBAUTHN_ORIGIN was set to the apex,
 * `https://myptstudio.com`, while the browser was served from
 * `https://www.myptstudio.com`. The ceremony then failed at the last possible
 * moment, in /register/verify:
 *
 *   Unexpected registration response origin "https://www.myptstudio.com",
 *   expected "https://myptstudio.com"
 *
 * Note this got as far as step 3, so nothing was wrong with rpId: the browser
 * had already accepted `myptstudio.com` because an RP ID only has to be a
 * registrable suffix of the page's domain, and the apex is a suffix of `www.`.
 * Only the origin comparison, which is exact, rejected it. So the two checks
 * disagreed about the same deployment — the RP ID spanned www and apex while
 * the origin did not.
 *
 * Toggling exactly one `www` label is the narrowest way to close that gap. It
 * cannot widen trust beyond what rpId already permits, and it deliberately
 * does NOT accept arbitrary subdomains — `evil.myptstudio.com` stays rejected.
 */
function withWwwSibling(origins) {
  const out = [];
  for (const o of origins) {
    if (!out.includes(o)) out.push(o);
    let u;
    try { u = new URL(o); } catch { continue; }
    u.hostname = u.hostname.startsWith('www.')
      ? u.hostname.slice(4)
      : `www.${u.hostname}`;
    // href on a bare origin gains a trailing slash; WebAuthn origins have none.
    const sibling = u.origin;
    if (!out.includes(sibling)) out.push(sibling);
  }
  return out;
}

function getExpectedOrigin(req) {
  const configured = (process.env.WEBAUTHN_ORIGIN || '')
    .split(',').map(o => o.trim()).filter(Boolean);
  const actual = requestOrigin(req);
  const rpId = getEffectiveRpId(req);

  // The caller's own origin is added to the allowlist when it satisfies the
  // same registrable-suffix test the browser applies. That is not a hole: a
  // credential the browser was willing to sign for this rpId could only have
  // come from an origin that already passes this test, so nothing is accepted
  // here that the rpId check was keeping out. What it buys is that a stale or
  // single-valued WEBAUTHN_ORIGIN stops being able to break verification on a
  // second domain pointed at the same API.
  const list = [...configured];
  if (actual && !list.includes(actual)) {
    let hostname = null;
    try { hostname = new URL(actual).hostname; } catch { /* ignore */ }
    if (isRegistrableSuffix(rpId, hostname)) {
      if (configured.length) {
        logger.warn(
          { actual, configured },
          'WEBAUTHN_ORIGIN does not list the requesting origin; accepting it because it '
          + 'matches the effective rpId. Add it to WEBAUTHN_ORIGIN to silence this.'
        );
      }
      list.push(actual);
    }
  }

  // Each accepted origin also admits its www-toggled sibling. WEBAUTHN_ORIGIN
  // set to the apex while the browser is served from `www.` (or the reverse)
  // otherwise fails at the last step, in /register/verify, even though rpId
  // already accepted the host as a registrable suffix — see withWwwSibling.
  const withSiblings = withWwwSibling(
    list.length ? list : [rpId === 'localhost' ? 'http://localhost:3000' : `https://${rpId}`]
  );
  return withSiblings.length === 1 ? withSiblings[0] : withSiblings;
}

/**
 * The challenge the authenticator actually signed, read back out of
 * clientDataJSON.
 *
 * Every verify path used to ask the database for "the newest unexpired
 * challenge for this user" instead, which is a different thing and is wrong
 * whenever there is more than one in flight: press Register twice, or leave a
 * second tab open, and the response signed against challenge #1 gets checked
 * against challenge #2 and fails with "Unexpected registration response
 * challenge". On /login/verify it was worse — that query also matched rows
 * with user_id IS NULL, i.e. any other person's anonymous login challenge.
 *
 * The response tells us which one it was. Ask for that one.
 */
function signedChallenge(payload) {
  try {
    const raw = payload?.response?.clientDataJSON;
    if (typeof raw !== 'string') return null;
    const data = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return typeof data.challenge === 'string' && data.challenge ? data.challenge : null;
  } catch {
    return null;
  }
}

// Lazy-load @simplewebauthn/server so a missing module only fails at call-time
let _wauthn = null;
function wauthn() {
  if (!_wauthn) _wauthn = require('@simplewebauthn/server');
  return _wauthn;
}

function setTokenCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

// userID for WebAuthn must be a Uint8Array in @simplewebauthn/server v13+.
// Passing a string throws "String values for `userID` are no longer supported".
function userIdToWebAuthn(uuid) {
  return Buffer.from(uuid, 'utf8'); // Buffer extends Uint8Array — v13 compatible
}

async function saveChallenge(challenge, userId, type) {
  await pool.query(
    `INSERT INTO webauthn_challenges (challenge, user_id, type, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')
     ON CONFLICT (challenge) DO NOTHING`,
    [challenge, userId || null, type]
  );
  // Expired rows were never collected anywhere — consumeChallenge only deletes
  // the one that verified, so every abandoned or failed attempt left a row
  // behind for good. Swept here rather than on a timer: it is one cheap indexed
  // delete on a path that already writes, and it needs no scheduler to exist.
  pool.query(`DELETE FROM webauthn_challenges WHERE expires_at < NOW()`)
    .catch((err) => logger.warn({ err: err.message }, 'webauthn challenge sweep failed'));
}

/**
 * Find the exact challenge a response was signed against.
 *
 * Falls back to the newest unexpired challenge of that type for the user when
 * clientDataJSON cannot be read, so a malformed-but-genuine client is no worse
 * off than it was before. `userId` null means the row must be anonymous.
 */
async function findChallenge({ signed, type, userId }) {
  if (signed) {
    const params = userId ? [signed, type, userId] : [signed, type];
    const scope = userId ? 'AND (user_id = $3 OR user_id IS NULL)' : 'AND user_id IS NULL';
    const { rows } = await pool.query(
      `SELECT challenge FROM webauthn_challenges
       WHERE challenge = $1 AND type = $2 AND expires_at > NOW() ${scope}`,
      params
    );
    if (rows.length) return rows[0].challenge;
    return null;
  }

  if (!userId) return null;
  const { rows } = await pool.query(
    `SELECT challenge FROM webauthn_challenges
     WHERE user_id = $1 AND type = $2 AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [userId, type]
  );
  return rows.length ? rows[0].challenge : null;
}

async function consumeChallenge(challenge, type, userId) {
  const params = userId ? [challenge, type, userId] : [challenge, type];
  const userCond = userId ? 'AND (user_id = $3 OR user_id IS NULL)' : '';
  const r = await pool.query(
    `DELETE FROM webauthn_challenges
     WHERE challenge = $1 AND type = $2 AND expires_at > NOW() ${userCond}
     RETURNING user_id`,
    params
  );
  return r.rows[0] || null;
}

async function logEvent(req, action, detail) {
  try {
    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, new_data, ip_address, user_agent)
       VALUES ($1, $2, $3, 'webauthn', $4, $5, $6, $7)`,
      [req.user?.id || null, req.user?.name || null, action,
       detail?.entity_id || null, detail || {},
       req.ip || null, req.get('user-agent') || null]
    );
  } catch (err) {
    logger.warn({ err: err.message, action }, 'webauthn activity log failed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRATION — logged-in user enrolling a new passkey
// ─────────────────────────────────────────────────────────────────────────────

// POST /register/options
router.post('/register/options', auth, withConfigCheck(async (req, res, next) => {
  try {
    const user = req.user;
    const rpId = getEffectiveRpId(req);
    logger.info({ rpId, userId: user.id }, 'webauthn register/options called');

    const { rows: existing } = await pool.query(
      `SELECT credential_id, transports FROM user_webauthn_credentials
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [user.id]
    );

    const { generateRegistrationOptions } = wauthn();
    let options;
    try {
      options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rpId,
        userID: userIdToWebAuthn(user.id),
        userName: user.email,
        userDisplayName: user.name || user.email,
        attestationType: 'none',
        excludeCredentials: existing.map(r => ({
          id: r.credential_id,
          transports: r.transports || [],
        })),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
          authenticatorAttachment: 'platform',
        },
      });
    } catch (err) {
      // Surface the actual error — production mask would hide it completely
      logger.error({ err: err.message, rpId, userId: user.id }, 'generateRegistrationOptions failed');
      return res.status(400).json({ error: `WebAuthn config error: ${err.message}` });
    }

    await saveChallenge(options.challenge, user.id, 'registration');
    res.json(options);
  } catch (err) {
    logger.error({ err: err.message }, 'register/options unexpected error');
    next(err);
  }
}));

// POST /register/verify
router.post('/register/verify', auth, withConfigCheck(async (req, res, next) => {
  try {
    const user = req.user;
    const { registration, deviceName, deviceType: clientDeviceType } = req.body;
    if (!registration) return res.status(400).json({ error: 'registration payload is required' });

    const challenge = await findChallenge({
      signed: signedChallenge(registration), type: 'registration', userId: user.id,
    });
    if (!challenge) {
      return res.status(400).json({ error: 'No valid challenge. Please restart registration.' });
    }

    const { verifyRegistrationResponse } = wauthn();
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: registration,
        expectedChallenge: challenge,
        expectedOrigin: getExpectedOrigin(req),
        expectedRPID: getEffectiveRpId(req),
        requireUserVerification: false,
      });
    } catch (err) {
      logger.warn({ err: err.message, userId: user.id }, 'Registration verify failed');
      return res.status(400).json({ error: 'Credential verification failed: ' + err.message });
    }

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verification failed' });
    }

    await consumeChallenge(challenge, 'registration', user.id);

    const regInfo = verification.registrationInfo;
    const { credential } = regInfo;
    const publicKeyB64 = Buffer.from(credential.publicKey).toString('base64url');

    const transports = credential.transports || registration?.response?.transports || [];
    let deviceType = 'unknown';
    if (transports.includes('internal')) deviceType = 'platform';
    else if (transports.some(t => ['usb', 'nfc', 'ble', 'smart-card'].includes(t))) deviceType = 'cross-platform';
    if (clientDeviceType) deviceType = clientDeviceType;

    // FIDO2 backup flags. Backup-State (BS) = credential is currently synced;
    // Backup-Eligible (BE) = credential *may* be synced (multi-device passkey).
    // @simplewebauthn v13 exposes BS as credentialBackedUp and BE via
    // credentialDeviceType ('multiDevice' ⇒ eligible); fall back defensively.
    const backedUp = regInfo.credentialBackedUp ?? credential.backedUp ?? false;
    const backupEligible = regInfo.credentialDeviceType
      ? regInfo.credentialDeviceType === 'multiDevice'
      : backedUp;

    const { rows } = await pool.query(
      `INSERT INTO user_webauthn_credentials
         (user_id, organization_id, credential_id, public_key, counter, transports,
          device_name, device_type, backed_up, backup_eligible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (credential_id) DO UPDATE
         SET last_used_at = NOW(), updated_at = NOW()
       RETURNING id`,
      [user.id, user.organization_id || null, credential.id, publicKeyB64, credential.counter,
       transports, (deviceName || 'Passkey').trim(),
       deviceType, backedUp, backupEligible]
    );

    await logEvent(req, 'webauthn_staff_registered', {
      entity_id: rows[0].id,
      user_id: user.id,
      credential_id: credential.id,
      device_name: deviceName || 'Passkey',
    });

    res.json({ success: true, credential: { id: rows[0].id } });
  } catch (err) { next(err); }
}));

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION — login with passkey (no session required)
// ─────────────────────────────────────────────────────────────────────────────

// POST /login/options
router.post('/login/options', authnLimiter, withConfigCheck(async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    let userId = null;
    let allowCredentials = [];

    if (email) {
      const { rows: users } = await pool.query(
        `SELECT id FROM users WHERE LOWER(email) = $1 AND is_active = true AND deleted_at IS NULL`,
        [email]
      );
      if (users.length) {
        userId = users[0].id;
        const { rows: creds } = await pool.query(
          `SELECT credential_id, transports FROM user_webauthn_credentials
           WHERE user_id = $1 AND is_active = true AND deleted_at IS NULL`,
          [userId]
        );
        allowCredentials = creds.map(r => ({
          id: r.credential_id,
          transports: r.transports || [],
        }));
      }
    }

    const { generateAuthenticationOptions } = wauthn();
    const options = await generateAuthenticationOptions({
      rpID: getEffectiveRpId(req),
      allowCredentials,
      userVerification: 'preferred',
    });

    await saveChallenge(options.challenge, userId, 'authentication');
    res.json(options);
  } catch (err) { next(err); }
}));

// POST /login/verify
router.post('/login/verify', authnLimiter, withConfigCheck(async (req, res, next) => {
  try {
    const { authentication } = req.body;
    if (!authentication) return res.status(400).json({ error: 'authentication payload is required' });

    const credentialId = authentication?.id;
    if (!credentialId) return res.status(400).json({ error: 'credentialId is required' });

    const { rows: credRows } = await pool.query(
      `SELECT credential_id, public_key, counter, transports, user_id, is_active
       FROM user_webauthn_credentials
       WHERE credential_id = $1 AND deleted_at IS NULL`,
      [credentialId]
    );
    if (!credRows.length) return res.status(404).json({ error: 'Credential not found' });
    const cred = credRows[0];
    if (!cred.is_active) return res.status(403).json({ error: 'This passkey has been disabled' });

    // Bound to the challenge this assertion actually signed. The previous query
    // took the newest row matching `user_id = $1 OR user_id IS NULL`, and
    // /login/options writes an anonymous row whenever the email is unknown — so
    // two people signing in at once could each pick up the other's challenge and
    // both fail.
    const challenge = await findChallenge({
      signed: signedChallenge(authentication), type: 'authentication', userId: cred.user_id,
    });
    if (!challenge) {
      return res.status(400).json({ error: 'No valid challenge. Please restart authentication.' });
    }

    const { verifyAuthenticationResponse } = wauthn();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: authentication,
        expectedChallenge: challenge,
        expectedOrigin: getExpectedOrigin(req),
        expectedRPID: getEffectiveRpId(req),
        credential: {
          id: cred.credential_id,
          publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
          counter: Number(cred.counter),
          transports: cred.transports || [],
        },
        requireUserVerification: false,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'Staff auth verify failed');
      return res.status(400).json({ error: 'Authentication verification failed' });
    }

    if (!verification.verified) return res.status(401).json({ error: 'Verification failed' });

    await consumeChallenge(challenge, 'authentication', cred.user_id);
    await pool.query(
      `UPDATE user_webauthn_credentials
       SET counter = $1, last_used_at = NOW(), updated_at = NOW()
       WHERE credential_id = $2`,
      [verification.authenticationInfo.newCounter, credentialId]
    );

    const { rows: users } = await pool.query(
      // organization_id is selected only so the login event carries studio
      // attribution; without it passkey sign-ins would be invisible to the
      // Security Centre's per-studio filter. Nothing else on this path reads it.
      `SELECT id, name, email, role, trainer_id, member_id, token_version, organization_id
       FROM users WHERE id = $1 AND is_active = true AND deleted_at IS NULL`,
      [cred.user_id]
    );
    if (!users.length) {
      return res.status(404).json({ error: 'User account not found or has been disabled' });
    }
    const user = users[0];

    // Tenant audience — the passkey door is the studio door. See the same
    // note in routes/auth-google.js and middleware/platformAuth.js.
    const token = jwt.sign(
      { id: user.id, token_version: user.token_version ?? 0, aud: AUD_TENANT },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    setTokenCookie(res, token);

    pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]).catch(() => {});
    loginEvents.record(req, {
      outcome: loginEvents.OUTCOMES.SUCCESS, method: 'passkey', email: user.email,
      userId: user.id, orgId: user.organization_id,
    });
    await logEvent(req, 'webauthn_staff_login', {
      entity_id: user.id,
      credential_id: credentialId,
    });

    res.json({
      success: true,
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, trainer_id: user.trainer_id, pt_client_id: user.pt_client_id,
      },
    });
  } catch (err) { next(err); }
}));

// ─────────────────────────────────────────────────────────────────────────────
// ACTION VERIFICATION — logged-in user re-verifying for a sensitive action
// Returns a short-lived (5 min) JWT with purpose=webauthn_action
// ─────────────────────────────────────────────────────────────────────────────

// POST /action/options
router.post('/action/options', auth, withConfigCheck(async (req, res, next) => {
  try {
    const user = req.user;
    const { rows: creds } = await pool.query(
      `SELECT credential_id, transports FROM user_webauthn_credentials
       WHERE user_id = $1 AND is_active = true AND deleted_at IS NULL`,
      [user.id]
    );
    if (!creds.length) {
      return res.status(404).json({ error: 'No passkeys registered for this account' });
    }

    const { generateAuthenticationOptions } = wauthn();
    const options = await generateAuthenticationOptions({
      rpID: getEffectiveRpId(req),
      allowCredentials: creds.map(r => ({
        id: r.credential_id,
        transports: r.transports || [],
      })),
      userVerification: 'required',
    });

    await saveChallenge(options.challenge, user.id, 'action');
    res.json(options);
  } catch (err) { next(err); }
}));

// POST /action/verify
router.post('/action/verify', auth, withConfigCheck(async (req, res, next) => {
  try {
    const user = req.user;
    const { authentication } = req.body;
    if (!authentication) return res.status(400).json({ error: 'authentication payload is required' });

    const credentialId = authentication?.id;
    const { rows: credRows } = await pool.query(
      `SELECT credential_id, public_key, counter, transports
       FROM user_webauthn_credentials
       WHERE credential_id = $1 AND user_id = $2 AND is_active = true AND deleted_at IS NULL`,
      [credentialId, user.id]
    );
    if (!credRows.length) return res.status(404).json({ error: 'Credential not found' });
    const cred = credRows[0];

    const challenge = await findChallenge({
      signed: signedChallenge(authentication), type: 'action', userId: user.id,
    });
    if (!challenge) return res.status(400).json({ error: 'No valid challenge. Please restart.' });

    const { verifyAuthenticationResponse } = wauthn();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: authentication,
        expectedChallenge: challenge,
        expectedOrigin: getExpectedOrigin(req),
        expectedRPID: getEffectiveRpId(req),
        credential: {
          id: cred.credential_id,
          publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
          counter: Number(cred.counter),
          transports: cred.transports || [],
        },
        requireUserVerification: true,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'webauthn action verification failed');
      return res.status(400).json({ error: 'Action verification failed' });
    }

    if (!verification.verified) return res.status(401).json({ error: 'Verification failed' });

    await consumeChallenge(challenge, 'action', user.id);
    await pool.query(
      `UPDATE user_webauthn_credentials
       SET counter = $1, last_used_at = NOW(), updated_at = NOW()
       WHERE credential_id = $2`,
      [verification.authenticationInfo.newCounter, credentialId]
    );

    const actionToken = jwt.sign(
      { id: user.id, purpose: 'webauthn_action' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );

    res.json({ actionToken });
  } catch (err) { next(err); }
}));

// ─────────────────────────────────────────────────────────────────────────────
// CREDENTIAL MANAGEMENT — user's own passkeys
// ─────────────────────────────────────────────────────────────────────────────

// GET /credentials
router.get('/credentials', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, device_name, device_type, backed_up, is_active,
              created_at, last_used_at
       FROM user_webauthn_credentials
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ credentials: rows });
  } catch (err) { next(err); }
});

// DELETE /credentials/:id
router.delete('/credentials/:id', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE user_webauthn_credentials
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Credential not found' });
    await logEvent(req, 'webauthn_credential_deleted', { entity_id: req.params.id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PATCH /credentials/:id — rename device
router.patch('/credentials/:id', auth, async (req, res, next) => {
  try {
    const { deviceName } = req.body;
    if (!deviceName?.trim()) return res.status(400).json({ error: 'deviceName is required' });
    const { rows } = await pool.query(
      `UPDATE user_webauthn_credentials
       SET device_name = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
       RETURNING id, device_name`,
      [deviceName.trim(), req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Credential not found' });
    res.json({ success: true, credential: rows[0] });
  } catch (err) { next(err); }
});

// PUT /credentials/:id/toggle — enable / disable
router.put('/credentials/:id/toggle', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE user_webauthn_credentials
       SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, is_active`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Credential not found' });
    await logEvent(req, rows[0].is_active ? 'webauthn_credential_enabled' : 'webauthn_credential_disabled', {
      entity_id: req.params.id,
    });
    res.json({ success: true, is_active: rows[0].is_active });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN endpoints — require admin or manager role
// ─────────────────────────────────────────────────────────────────────────────

function requireAdminOrManager(req, res, next) {
  const role = req.user.role;
  if (role !== 'admin' && role !== 'manager' && role !== 'super_admin') {
    return res.status(403).json({ error: 'Admin or manager access required' });
  }
  next();
}

// GET /admin/config — what rpId and origin this instance will actually use for
// the caller, and whether the browser can accept them.
//
// This exists because the failure it diagnoses is otherwise invisible from the
// server: a wrong rpId makes /register/options return 200 with a valid
// challenge, and the refusal happens inside the browser, which reports it to
// nobody. One authenticated GET now answers "why does nothing happen when I
// tap Add Passkey" without shell access to the box.
//
// Returns hostnames the caller's own browser already knows and booleans about
// whether two env vars are set — never their values beyond the host, and no
// secrets.
router.get('/admin/config', auth, requireAdminOrManager, (req, res) => {
  const hostname = requestHostname(req);
  const rpId = getEffectiveRpId(req);
  const expectedOrigin = getExpectedOrigin(req);
  const configuredRpId = process.env.RP_ID || null;
  const usable = isRegistrableSuffix(rpId, hostname);
  const honoured = configuredRpId && isRegistrableSuffix(configuredRpId, hostname);

  res.json({
    requestHostname: hostname,
    requestOrigin: requestOrigin(req),
    effectiveRpId: rpId,
    expectedOrigin,
    configuredRpId,
    frontendHostname: frontendHostname(),
    rpIdSource: honoured ? 'RP_ID'
      : configuredRpId ? 'FRONTEND_URL (RP_ID rejected — see problem)'
      : rpId === 'localhost' ? 'fallback' : 'FRONTEND_URL',
    webauthnOriginConfigured: Boolean(process.env.WEBAUTHN_ORIGIN),
    // false here means passkeys cannot work from this host, full stop.
    browserWillAcceptRpId: usable,
    problem: usable ? null
      : `rpId "${rpId}" is not equal to, nor a registrable suffix of, "${hostname}" — `
        + 'the browser will reject every enrolment with SecurityError.',
  });
});

// GET /admin/stats — tenant-scoped: platform super_admin sees all orgs;
// a tenant admin/manager sees only their own organization's passkeys.
router.get('/admin/stats', auth, requireAdminOrManager, async (req, res, next) => {
  try {
    const { orgId, applyFilter } = tenantScope(req);
    const where  = applyFilter ? 'WHERE u.organization_id = $1' : '';
    const params = applyFilter ? [orgId] : [];
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE uc.deleted_at IS NULL)::int                        AS total_credentials,
        COUNT(*) FILTER (WHERE uc.deleted_at IS NULL AND uc.is_active = true)::int AS active_credentials,
        COUNT(DISTINCT uc.user_id) FILTER (WHERE uc.deleted_at IS NULL)::int       AS users_with_passkeys,
        COUNT(*) FILTER (WHERE uc.last_used_at > NOW() - INTERVAL '7 days')::int   AS used_last_7_days
      FROM user_webauthn_credentials uc
      JOIN users u ON u.id = uc.user_id
      ${where}
    `, params);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /admin/credentials — tenant-scoped list.
router.get('/admin/credentials', auth, requireAdminOrManager, async (req, res, next) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit,  10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0,   0);
    const { orgId, applyFilter } = tenantScope(req);

    const conds  = ['uc.deleted_at IS NULL'];
    const params = [];
    if (applyFilter) { params.push(orgId); conds.push(`u.organization_id = $${params.length}`); }
    params.push(limit);  const limIdx = params.length;
    params.push(offset); const offIdx = params.length;

    const { rows } = await pool.query(
      `SELECT uc.id, uc.user_id, u.name AS user_name, u.email AS user_email,
              uc.device_name, uc.device_type, uc.backed_up, uc.backup_eligible, uc.is_active,
              uc.created_at, uc.last_used_at
       FROM user_webauthn_credentials uc
       JOIN users u ON u.id = uc.user_id
       WHERE ${conds.join(' AND ')}
       ORDER BY uc.created_at DESC
       LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    );
    res.json({ credentials: rows });
  } catch (err) { next(err); }
});

// DELETE /admin/credentials/:id — admin revoke, tenant-scoped so an org admin
// can only revoke passkeys belonging to a user in their own organization.
router.delete('/admin/credentials/:id', auth, async (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    const { orgId, applyFilter } = tenantScope(req);
    const params = [req.params.id];
    let orgCond = '';
    if (applyFilter) { params.push(orgId); orgCond = `AND u.organization_id = $${params.length}`; }

    const { rows } = await pool.query(
      `UPDATE user_webauthn_credentials uc
       SET deleted_at = NOW(), updated_at = NOW()
       FROM users u
       WHERE uc.id = $1 AND u.id = uc.user_id AND uc.deleted_at IS NULL
         ${orgCond}
       RETURNING uc.id`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Credential not found' });
    await logEvent(req, 'webauthn_admin_revoke', { entity_id: req.params.id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /admin/audit-logs — tenant-scoped. A tenant admin sees webauthn events
// performed by users in their org (registration/management, actor-based) plus
// login events targeting a user in their org (target-based, since login has no
// authenticated actor). Platform super_admin sees everything.
router.get('/admin/audit-logs', auth, requireAdminOrManager, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const { orgId, applyFilter } = tenantScope(req);

    const params = [];
    let orgCond = '';
    if (applyFilter) {
      params.push(orgId);
      orgCond = `AND (u.organization_id = $${params.length}
                   OR al.entity_id IN (SELECT id FROM users WHERE organization_id = $${params.length}))`;
    }
    params.push(limit);
    const limIdx = params.length;

    const { rows } = await pool.query(
      `SELECT al.id, al.user_id, al.user_name, al.action, al.entity_id,
              al.new_data, al.ip_address, al.user_agent, al.created_at
       FROM activity_log al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE al.entity_type = 'webauthn'
         ${orgCond}
       ORDER BY al.created_at DESC
       LIMIT $${limIdx}`,
      params
    );
    res.json({ logs: rows });
  } catch (err) { next(err); }
});

module.exports = router;

// Exported for tests. These four decide whether passkeys work at all and none
// of them touches the database, so they are worth pinning directly rather than
// through a route that would need a pool to reach them.
module.exports.isRegistrableSuffix = isRegistrableSuffix;
module.exports.getEffectiveRpId    = getEffectiveRpId;
module.exports.getExpectedOrigin   = getExpectedOrigin;
module.exports.signedChallenge     = signedChallenge;
