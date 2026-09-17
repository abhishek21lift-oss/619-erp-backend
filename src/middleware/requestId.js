'use strict';
// Mint a correlation id, echo it, and open the context every log line reads.
//
// The id and the header were already here. What was missing is the third line:
// nothing carried the id past this function, so `req.id` reached exactly one
// log statement in the application — the access log — and every line that
// explains WHY a request behaved as it did was unattributable.
//
// The context is opened around next(), so everything downstream of this
// middleware runs inside it: route handlers, services, db/pool.js, and any
// promise they leave running. lib/logger.js's mixin reads it per line.
//
// Mounted EARLY — before auth, before the body parsers, before the limiters —
// because a request that is rejected by a rate limiter or fails to
// authenticate is precisely the one someone will ask about later, and it has
// to be traceable too.
//
// An inbound x-request-id is honoured so a trace started by the frontend, or
// by the WhatsApp gateway calling in, continues rather than restarting. That
// is a header from outside, so it is bounded and stripped of anything that
// does not belong in a log field.
const { randomUUID } = require('crypto');
const { runWithRequestContext } = require('../lib/request-context');

/** At most 128 chars of id-shaped text, or nothing. */
function sanitizeInboundId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 128);
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

module.exports = function requestId(req, res, next) {
  const id = sanitizeInboundId(req.headers['x-request-id']) || randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  runWithRequestContext({ requestId: id }, () => next());
};
