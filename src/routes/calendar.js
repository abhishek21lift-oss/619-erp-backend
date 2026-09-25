// src/routes/calendar.js
// Google Calendar OAuth flow + connection status endpoints.
//
// GET  /api/calendar/auth-url    — returns the Google consent URL (auth required)
// GET  /api/calendar/callback    — OAuth2 redirect handler (no auth — Google calls this);
//                                  hands code+state to the frontend, stores nothing
// POST /api/calendar/complete    — exchanges the code, for the signed-in user who
//                                  started the flow and nobody else (auth required)
// GET  /api/calendar/status      — connection status for current user (auth required)
// DELETE /api/calendar/disconnect — revoke & delete tokens (auth required)

'use strict';

const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const { auth } = require('../middleware/auth');
const cal    = require('../lib/google-calendar');
const logger = require('../lib/logger');
const { frontendUrl } = require('../lib/frontendUrl');


function notConfigured(res) {
  return res.status(501).json({
    error: 'Google Calendar integration is not configured on this server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALENDAR_REDIRECT_URI.',
  });
}

// ── GET /api/calendar/auth-url ────────────────────────────────────────────────
// Returns the Google OAuth consent URL. The frontend redirects the user there.
// We embed the user_id in a short-lived signed state token so the callback can
// identify the user without needing the session cookie (Google redirects the
// browser, which loses the httpOnly cookie context in some edge cases).
router.get('/auth-url', auth, (req, res) => {
  if (!cal.isConfigured()) return notConfigured(res);

  const stateToken = jwt.sign(
    { user_id: req.user.id, purpose: 'calendar_oauth' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );

  const url = cal.generateAuthUrl(stateToken);
  // Log the redirect_uri so mismatches are easy to diagnose in the server logs.
  // Not returned to the browser: it was only ever a debugging aid.
  logger.info({ redirectUri: process.env.GOOGLE_CALENDAR_REDIRECT_URI }, 'Google Calendar: generated auth URL');
  res.json({ url });
});

// ── GET /api/calendar/callback ────────────────────────────────────────────────
// Google redirects the browser here after consent. It stores nothing: it hands
// code + state to the frontend Integrations page, which completes the
// connection through POST /complete below, inside the user's own session.
//
// This route used to verify `state` and save the tokens straight onto
// state.user_id. `state` names who STARTED the flow; nothing checked who
// FINISHED it. So anyone could mint a state for their own account, send
// someone the Google consent link built from it, and — if that person clicked
// "Allow" — have the victim's Google Calendar written onto the attacker's ERP
// account (OAuth login CSRF).
//
// Bound through the session rather than a nonce cookie because the callback
// may be served on a different host (api.) from the one that minted the state,
// where such a cookie would never be sent.
router.get('/callback', (req, res) => {
  // Normalised: FRONTEND_URL carries a trailing slash in production, which
  // would send the user to ".com//settings/integrations" after authorising.
  const redirectBase = frontendUrl('/settings/integrations') || 'http://localhost:3000/settings/integrations';
  if (!cal.isConfigured()) return res.redirect(`${redirectBase}?calendar=error&reason=not_configured`);

  const { code, state, error } = req.query;
  if (error) {
    logger.warn({ error }, 'Google Calendar OAuth denied by user');
    return res.redirect(`${redirectBase}?calendar=denied`);
  }
  if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
    return res.redirect(`${redirectBase}?calendar=error&reason=missing_params`);
  }

  const params = new URLSearchParams({ calendar: 'confirm', code, state });
  return res.redirect(`${redirectBase}?${params.toString()}`);
});

// ── POST /api/calendar/complete  { code, state } ──────────────────────────────
// Exchanges the code for the signed-in user — and only when the state was
// minted for that same user. The browser Google redirected carries its own
// session, so a consent link forwarded from someone else's account is refused
// here before the code is ever exchanged.
const EXPIRED_LINK = 'This connection link has expired. Please try connecting again.';

router.post('/complete', auth, async (req, res) => {
  if (!cal.isConfigured()) return notConfigured(res);

  const { code, state } = req.body || {};
  if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
    return res.status(400).json({ error: 'code and state are required' });
  }

  let payload;
  try {
    payload = jwt.verify(state, process.env.JWT_SECRET);
  } catch (stateErr) {
    logger.warn({ err: stateErr.message }, 'Google Calendar: invalid state token');
    return res.status(400).json({ error: EXPIRED_LINK });
  }
  if (payload.purpose !== 'calendar_oauth' || !payload.user_id) {
    return res.status(400).json({ error: EXPIRED_LINK });
  }
  if (String(payload.user_id) !== String(req.user.id)) {
    logger.warn({ userId: req.user.id }, 'Google Calendar: state was minted for a different user — refused');
    return res.status(403).json({ error: 'This connection was started from a different account. Please try connecting again.' });
  }

  try {
    await cal.saveTokensFromCode(req.user.id, code);
    logger.info({ userId: req.user.id }, 'Google Calendar: tokens saved');
    return res.json({ connected: true });
  } catch (tokenErr) {
    logger.error({ userId: req.user.id, err: tokenErr.message }, 'Google Calendar: token exchange failed');
    return res.status(502).json({ error: 'Google did not accept the connection. Please try again.' });
  }
});

// ── GET /api/calendar/status ──────────────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  if (!cal.isConfigured()) return notConfigured(res);
  try {
    const status = await cal.getStatus(req.user.id);
    res.json(status);
  } catch (err) {
    logger.error({ err: err.message }, 'Google Calendar: status check failed');
    res.status(500).json({ error: 'Failed to check calendar status' });
  }
});

// ── DELETE /api/calendar/disconnect ──────────────────────────────────────────
router.delete('/disconnect', auth, async (req, res) => {
  if (!cal.isConfigured()) return notConfigured(res);
  try {
    await cal.disconnect(req.user.id);
    res.json({ message: 'Google Calendar disconnected' });
  } catch (err) {
    logger.error({ err: err.message }, 'Google Calendar: disconnect failed');
    res.status(500).json({ error: 'Failed to disconnect calendar' });
  }
});

module.exports = router;
