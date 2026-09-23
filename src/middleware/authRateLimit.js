'use strict';
// src/middleware/authRateLimit.js
//
// Rate limiting for the credential endpoints, keyed on something better than
// "which building is this person standing in".
//
// ── The lockout this replaces ──────────────────────────────────────────────
//
// One limiter instance guarded login, google-login AND refresh:
//
//     const loginLimiter = rateLimit({ store: makeStore('login'),
//                                      windowMs: 15 * 60 * 1000, max: 30 });
//     app.use('/api/auth/login',   loginLimiter);
//     app.use('/api/auth/refresh', loginLimiter);   // ← same instance
//
// Default keyGenerator, so the key was the IP. A studio has one public IP,
// and everyone in the building shares it — the trainer on their laptop and
// their phone, and every member signing in from the studio's wifi — thirty
// attempts per quarter-hour between all of them.
//
// Refresh is what makes it certain rather than merely likely. The access token
// lives 15 minutes (ACCESS_TOKEN_TTL_MS in routes/auth.js) and the browser
// renews it automatically, so every signed-in account spends at least one
// request from that shared bucket per window without touching a keyboard —
// more with a second tab, a phone, or a reload. A trainer and a handful of
// members on the studio's wifi can consume the entire login budget through
// renewals alone, and then nobody can sign in,
// and nothing in the logs says why: the 429 says "too many login attempts" to
// a person who has not attempted a login.
//
// ── The dimensions, and what each one is actually for ──────────────────────
//
// IDENTITY is the brute-force control. An attacker guessing passwords for one
// account should be stopped on that account whether they come from one address
// or a thousand, and a member mistyping their own password must not spend the
// trainer's budget. Keyed on a hash of what was typed into the email box —
// so it is per-account and costs a studio nothing.
//
// IP is the credential-stuffing control, and nothing else. One host trying
// many different accounts is the shape it catches, so its ceiling is set high
// enough that a whole studio working normally never approaches it.
//
// DEVICE is the refresh token itself. Every browser and phone holds its own,
// its hash is already computed by the refresh handler, and it cannot be
// spoofed by an attacker who does not hold the token. That gives each device a
// private renewal budget that no colleague and no stranger on the same IP can
// consume — which is the whole failure above, removed at the root rather than
// by raising a number.
//
// ── Why failures, and not attempts ─────────────────────────────────────────
//
// `skipSuccessfulRequests` on both login limiters. A staff member who signs in
// correctly has demonstrated they are not the thing being defended against, so
// the attempt costs nothing. Brute force is made of failures, so the budget is
// spent only by the traffic it exists to stop — which is what lets the
// identity ceiling be THREE TIMES STRICTER than the old shared one (10 failed
// attempts per account, against 30 attempts of any kind per building) while
// being far harder to trip by accident.

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { makeStore } = require('../lib/rateLimitStore');

const isProd = process.env.NODE_ENV === 'production';
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Failed sign-ins allowed per ACCOUNT per window.
 *
 * Ten, against the thirty a whole studio shared. Stricter where it matters and
 * looser where it hurt: this is the number an attacker has to beat, and it is
 * no longer the number a busy studio has to stay under.
 */
const LOGIN_FAILURES_PER_IDENTITY = Number(process.env.LOGIN_MAX_FAILURES_PER_IDENTITY || 10);

/**
 * Failed sign-ins allowed per SOURCE ADDRESS per window.
 *
 * Deliberately generous. Its job is one host working through a list of
 * accounts, not a studio having a bad morning: twelve staff each failing twice
 * is 24, and this is an order of magnitude above that.
 */
const LOGIN_FAILURES_PER_IP = Number(process.env.LOGIN_MAX_FAILURES_PER_IP || (isProd ? 100 : 500));

/**
 * Token renewals allowed per DEVICE per window.
 *
 * A well-behaved client renews about once per access-token lifetime — four
 * times an hour, so one per window. Sixty leaves room for tabs, a flapping
 * network and a retry loop, while still bounding a client that has genuinely
 * gone haywire. Per device, so a haywire client bounds only itself.
 */
const REFRESH_PER_DEVICE = Number(process.env.REFRESH_MAX_PER_DEVICE || 60);

/**
 * Hash anything used as a rate-limit key.
 *
 * Keys travel to Redis and appear in logs and dumps. An email address is a
 * person; a refresh token is a live credential that would otherwise be sitting
 * in a key name where anyone with Redis access could replay it. Neither
 * belongs there in the clear, and a limiter only needs the value to be stable
 * and unique, which a digest is.
 */
function hashKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

/**
 * The identity a login request is for.
 *
 * Normalised the same way the login query matches it — `LOWER(u.email)` — so
 * "Owner@Gym.com" and "owner@gym.com" share one budget instead of handing an
 * attacker a fresh ten attempts per capitalisation.
 *
 * Returns null when the request carries no email at all, which is the
 * google-login and passkey shape. Those fall back to the address bucket rather
 * than sharing one "unknown" bucket across every studio on the platform.
 */
function identityOf(req) {
  const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return email ? hashKey(email) : null;
}

/**
 * The device a refresh request comes from: its refresh token.
 *
 * Falls back to the address when no token was presented — such a request is
 * about to be refused with 401 anyway, and bucketing it by address is what
 * stops an anonymous flood from being free.
 */
function deviceOf(req) {
  const raw = (req.cookies && req.cookies.refresh_token) || (req.body && req.body.refresh_token);
  return raw ? `d:${hashKey(raw)}` : `ip:${req.ip}`;
}

/**
 * One 429 shape, with an honest Retry-After.
 *
 * express-rate-limit's default body is a bare string and sets no Retry-After,
 * so a client has nothing to wait on and retries immediately — which spends
 * the next window's budget on the way in. `scope` names which budget tripped
 * so a support call can be answered without reading Redis, and it leaks
 * nothing: a caller learns only about the limit their own traffic hit.
 *
 * Never reveals whether an account exists. The identity bucket counts failures
 * against whatever string was typed, real or not, so tripping it says nothing
 * about the account — which is the property that lets this message be specific
 * at all.
 */
function limitHandler(scope, message) {
  return (req, res) => {
    const resetMs = req.rateLimit && req.rateLimit.resetTime
      ? Math.max(0, req.rateLimit.resetTime.getTime() - Date.now())
      : WINDOW_MS;
    const retryAfterSec = Math.max(1, Math.ceil(resetMs / 1000));
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json({
      error: message,
      scope,
      retry_after_seconds: retryAfterSec,
    });
  };
}

/**
 * Shared options.
 *
 * `store` and `passOnStoreError` are deliberately NOT here. They are repeated
 * at each limiter below, because rateLimitStore.test.js reads call sites: it
 * exists to catch a limiter added later WITHOUT a store, and a property
 * arriving through a spread is invisible to it. Repeating two lines three
 * times is the price of that check staying able to fail, and it also puts the
 * degradation behaviour where a reviewer reads the limiter.
 */
const base = {
  windowMs: WINDOW_MS,
  standardHeaders: true,
  legacyHeaders: false,
};

/**
 * Per-account failed-login budget.
 *
 * Skipped entirely when the request carries no email, so a passkey or Google
 * sign-in is not charged to an "anonymous" account shared platform-wide.
 */
const loginIdentityLimiter = rateLimit({
  ...base,
  store: makeStore('login-id'),
  passOnStoreError: true,
  max: LOGIN_FAILURES_PER_IDENTITY,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => identityOf(req) || `ip:${req.ip}`,
  skip: (req) => identityOf(req) === null,
  handler: limitHandler(
    'identity',
    'Too many failed sign-in attempts for this account. Please wait before trying again.'
  ),
});

/**
 * Per-address failed-login budget: the credential-stuffing ceiling.
 *
 * Applies to every credential endpoint including the ones with no email, which
 * is why it is a separate limiter rather than the `skip` branch above.
 */
const loginIpLimiter = rateLimit({
  ...base,
  store: makeStore('login-ip'),
  passOnStoreError: true,
  max: LOGIN_FAILURES_PER_IP,
  skipSuccessfulRequests: true,
  handler: limitHandler(
    'address',
    'Too many failed sign-in attempts from this network. Please wait before trying again.'
  ),
});

/**
 * Per-device token renewal budget.
 *
 * Its own store prefix, which is the entire point: sharing `login`'s prefix is
 * what let automatic renewals lock a studio out of signing in. A prefix is the
 * counter, so two limiters sharing one share a budget.
 */
const refreshLimiter = rateLimit({
  ...base,
  store: makeStore('refresh-device'),
  passOnStoreError: true,
  max: REFRESH_PER_DEVICE,
  keyGenerator: deviceOf,
  handler: limitHandler(
    'device',
    'Too many token renewals from this device. Please sign in again.'
  ),
});

module.exports = {
  loginIdentityLimiter,
  loginIpLimiter,
  refreshLimiter,
  // Exported for tests and for anything that needs the same normalisation.
  identityOf,
  deviceOf,
  hashKey,
  limits: {
    WINDOW_MS,
    LOGIN_FAILURES_PER_IDENTITY,
    LOGIN_FAILURES_PER_IP,
    REFRESH_PER_DEVICE,
  },
};
