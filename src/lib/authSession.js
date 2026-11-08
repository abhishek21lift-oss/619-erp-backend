'use strict';
// Session issuance shared by every password-equivalent door.
//
// The password login, Google login and Google link must mint exactly the same
// session: a 15-minute tenant access cookie, a rotating 7-day refresh token,
// and the same user payload. Keeping the primitives in one module is what
// stops the three routes drifting on cookie flags or audience.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const isSecure = process.env.NODE_ENV !== 'development';

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;          // 15 minutes
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// One cookie namespace per door, so three sessions can share a browser.
//
// `token`/`refresh_token` remain as a mirror of the most recent login. They
// are read only when the caller names no portal, which is what lets an
// installed app or a session minted before this change keep working while the
// new cookies are rolled out.
const PORTALS = ['trainer', 'member', 'platform'];

function isPortal(value) {
  return PORTALS.includes(value);
}

function portalCookieNames(portal) {
  return { access: `${portal}_token`, refresh: `${portal}_refresh` };
}

/** The portal named by the caller. A SELECTOR, never an authorization fact. */
function headerPortal(req) {
  const raw = String((req.headers && req.headers['x-portal']) || '').toLowerCase();
  return isPortal(raw) ? raw : null;
}

/** The portal whose cookies are present, when exactly one namespace is. */
function cookiePortal(cookies) {
  const found = PORTALS.filter((portal) => {
    const n = portalCookieNames(portal);
    return !!(cookies && (cookies[n.access] || cookies[n.refresh]));
  });
  return found.length === 1 ? found[0] : null;
}

function requestPortal(req) {
  return headerPortal(req) || cookiePortal(req.cookies);
}

function legacyRefreshMatches(req, portal) {
  const own = req.cookies && req.cookies[portalCookieNames(portal).refresh];
  return !!(own && req.cookies.refresh_token === own);
}

/**
 * The access token to verify, and the portal namespace it came from.
 *
 * With a named portal, the legacy cookie is a migration fallback only: it is
 * still checked against that portal after the user row is loaded.
 */
function accessTokenFor(req) {
  const portal = requestPortal(req);
  if (portal) {
    return {
      token: (req.cookies && (req.cookies[portalCookieNames(portal).access] || req.cookies.token)) || null,
      portal,
    };
  }
  return { token: (req.cookies && req.cookies.token) || null, portal: null };
}

const ACCESS_COOKIE = { httpOnly: true, secure: isSecure, sameSite: 'strict', path: '/' };
const REFRESH_COOKIE = { httpOnly: true, secure: isSecure, sameSite: 'strict', path: '/api/auth' };

function setAccessCookie(res, portal, token, { maxAgeMs = ACCESS_TOKEN_TTL_MS, mirrorLegacy = false } = {}) {
  res.cookie(portalCookieNames(portal).access, token, { ...ACCESS_COOKIE, maxAge: maxAgeMs });
  if (mirrorLegacy) res.cookie('token', token, { ...ACCESS_COOKIE, maxAge: maxAgeMs });
}

function setRefreshCookie(res, portal, rawToken, mirrorLegacy) {
  res.cookie(portalCookieNames(portal).refresh, rawToken, { ...REFRESH_COOKIE, maxAge: REFRESH_TOKEN_TTL_MS });
  if (mirrorLegacy) res.cookie('refresh_token', rawToken, { ...REFRESH_COOKIE, maxAge: REFRESH_TOKEN_TTL_MS });
}

function clearLegacyCookies(res) {
  res.clearCookie('token', ACCESS_COOKIE);
  res.clearCookie('refresh_token', REFRESH_COOKIE);
}

function clearPortalCookies(res, portal, { legacy = false } = {}) {
  if (portal) {
    const n = portalCookieNames(portal);
    res.clearCookie(n.access, ACCESS_COOKIE);
    res.clearCookie(n.refresh, REFRESH_COOKIE);
  }
  if (legacy) clearLegacyCookies(res);
}

/**
 * Mint an access token for `userId` on a given plane.
 *
 * Every access token in the auth routes goes through here so that the
 * audience cannot be forgotten at one of the mint sites. `audience` is null
 * for a legacy session being refreshed (migration 162), and a null claim is
 * omitted rather than written, so those tokens keep exactly the shape they
 * had.
 */
function signAccessToken(userId, tokenVersion, audience) {
  const payload = { id: userId, token_version: tokenVersion };
  if (audience) payload.aud = audience;
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });
}

/**
 * May this response carry the session tokens in its JSON body?
 *
 * Only for a caller that is not a browser. A browser already holds both
 * tokens as httpOnly cookies — set on this same response — and a copy in the
 * body is the one place page script can read them, so any XSS could lift a
 * seven-day refresh token. The web app never reads it (its login call is
 * typed `{ user }`), and the Android app is a WebView of the same origin, so
 * it rides the cookies too.
 *
 * `Origin` is the signal because browsers attach it to every POST and page
 * script cannot remove it (a forbidden header name). Scripts, the E2E API
 * suite and any native client send none, and keep the body tokens they use
 * today.
 */
function bodyTokensAllowed(req) {
  return !req.headers.origin;
}

async function issueRefreshToken(res, userId, audience = null, portal = 'trainer', { mirrorLegacy = true } = {}) {
  const rawToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  // The audience rides on the refresh token because it is a property of the
  // SESSION, and the refresh token is the only part of a session that outlives
  // fifteen minutes. See migration 162.
  //
  // Falls back to the pre-162 shape on undefined_column. Migrations run at
  // boot, so this window is narrow, but it covers the deployment where the new
  // code is live for the seconds before its migration lands — and the cost of
  // not covering it is that nobody can sign in during those seconds.
  try {
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, audience) VALUES ($1, $2, $3, $4)',
      [userId, tokenHash, expiresAt, audience]
    );
  } catch (err) {
    if (err && err.code === '42703') {
      await pool.query(
        'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [userId, tokenHash, expiresAt]
      );
    } else {
      throw err;
    }
  }
  setRefreshCookie(res, portal, rawToken, mirrorLegacy);
  // Returned (not just cookied) so mobile/native clients — which don't share
  // a browser cookie jar — can store it themselves and send it back via
  // Authorization header / request body instead of a cookie.
  return rawToken;
}

/**
 * Revoke every live refresh token for a user.
 *
 * Bumping users.token_version kills access tokens, but refresh rows are a
 * separate mechanism and were never consulted for it — left live, another
 * device can mint a fresh access token for up to the refresh token's seven-day
 * lifetime.
 */
async function revokeRefreshTokensForUser(userId) {
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
}

/**
 * The user object every door returns. The client adopts this as the signed-in
 * user without fetching /api/auth/me, so a missing field paints the wrong
 * shell until a hard reload.
 */
function sessionUserPayload(user, extra = {}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    trainer_id: user.trainer_id,
    pt_client_id: user.pt_client_id,
    organization_id: user.organization_id,
    organization_name: user.organization_name,
    organization_logo_url: user.organization_logo_url,
    is_founder: Boolean(user.is_founder),
    founder_number: user.founder_number ?? null,
    avatar_url: user.avatar_url ?? null,
    ...extra,
  };
}

module.exports = {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  PORTALS,
  portalCookieNames,
  requestPortal,
  legacyRefreshMatches,
  accessTokenFor,
  setAccessCookie,
  setRefreshCookie,
  clearLegacyCookies,
  clearPortalCookies,
  signAccessToken,
  issueRefreshToken,
  revokeRefreshTokensForUser,
  bodyTokensAllowed,
  sessionUserPayload,
};
