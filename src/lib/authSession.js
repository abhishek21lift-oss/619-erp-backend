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

function setTokenCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    maxAge: ACCESS_TOKEN_TTL_MS,
    path: '/',
  });
}

function setRefreshCookie(res, rawToken) {
  res.cookie('refresh_token', rawToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    maxAge: REFRESH_TOKEN_TTL_MS,
    path: '/api/auth',
  });
}

function clearSessionCookies(res) {
  res.clearCookie('token', { httpOnly: true, secure: isSecure, sameSite: 'strict', path: '/' });
  res.clearCookie('refresh_token', { httpOnly: true, secure: isSecure, sameSite: 'strict', path: '/api/auth' });
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

async function issueRefreshToken(res, userId, audience = null) {
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
  setRefreshCookie(res, rawToken);
  // Returned (not just cookied) so mobile/native clients — which don't share
  // a browser cookie jar — can store it themselves and send it back via
  // Authorization header / request body instead of a cookie.
  return rawToken;
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
  setTokenCookie,
  setRefreshCookie,
  clearSessionCookies,
  signAccessToken,
  issueRefreshToken,
  bodyTokensAllowed,
  sessionUserPayload,
};
