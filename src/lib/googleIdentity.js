'use strict';
// One server-side verifier for every Google door.
//
// The ID token is checked against the configured client id and Google's
// keys. The caller gets a payload only when the token is valid AND the email
// is verified AND the stable subject is present; anything else is the same
// 401 shape, so a forged or stale token cannot be distinguished from a
// malformed one.

const { OAuth2Client } = require('google-auth-library');
const logger = require('./logger');

function failure(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function verifyGoogleCredential(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw failure('GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured on this server');
  }
  if (!credential || typeof credential !== 'string') {
    throw failure('GOOGLE_INVALID_CREDENTIAL', 'Invalid Google credential');
  }

  let payload;
  try {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch (err) {
    logger.warn({ err: err.message }, 'Google token verification failed');
    throw failure('GOOGLE_INVALID_CREDENTIAL', 'Invalid Google credential');
  }

  if (!payload || !payload.sub || !payload.email || !payload.email_verified) {
    throw failure('GOOGLE_INVALID_CREDENTIAL', 'Google account email is not verified');
  }

  return payload;
}

module.exports = { verifyGoogleCredential };
