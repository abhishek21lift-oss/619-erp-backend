// src/middleware/originCheck.js
// Defense-in-depth: reject API requests from unexpected origins.
// Mount AFTER CORS but BEFORE routes.
//
// This catches request smuggling, DNS rebinding, and cases where
// CORS preflight passes but the actual request should be blocked.
// It's safe because legitimate browsers always send Origin or Referer.

const logger = require('../lib/logger');

// Paths that must not be origin-checked.
//
// NOTE the leading segment: this middleware is mounted with app.use('/api/', …),
// and Express strips the mount path, so inside here req.path is '/health' — NOT
// '/api/health'. The previous check compared against '/api/health' and therefore
// never matched anything. It went unnoticed because Render's health probe sends
// no Origin or Referer and so exits on the line above.
const ORIGIN_EXEMPT = new Set([
  '/health',
]);

// Prefixes rather than exact paths, for exempt routes that carry an id.
const ORIGIN_EXEMPT_PREFIXES = [
  // The invitation email's open-tracking pixel. It is fetched by a mail client
  // or an image proxy (Gmail's, Outlook's), never by our own frontend, so an
  // origin allowlist can only reject it — and whichever Referer those proxies
  // do send is not something we control or can enumerate.
  //
  // Exempting it gives nothing away: the URL carries an opaque track_id, not
  // the invitation token, and the only effect a request can have is flipping
  // one invitation from 'sent' to 'opened'. There is no state an attacker
  // would want and nothing to read back — the response is a 1x1 GIF either
  // way, including for ids that do not exist.
  '/invitations/track/',
];

function allowedOriginSet() {
  const out = new Set();
  const add = (raw) => {
    try {
      const url = new URL(String(raw).trim());
      // Only schemes a browser sends as an Origin. A typo in an env value
      // must not open the gate, so anything else is dropped rather than
      // string-compared.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      out.add(url.origin);
    } catch { /* malformed value: contributes nothing */ }
  };
  if (process.env.FRONTEND_URL) add(process.env.FRONTEND_URL);
  if (process.env.CORS_ORIGIN) String(process.env.CORS_ORIGIN).split(',').forEach(add);
  return out;
}

function isLocalDevHost(hostname) {
  // `[::1]` is what URL.hostname reports for IPv6 loopback — brackets included.
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function originCheck(req, res, next) {
  // Skip for server-to-server calls (no origin) and health checks
  if (!req.headers.origin && !req.headers.referer) return next();
  if (ORIGIN_EXEMPT.has(req.path)) return next();
  if (ORIGIN_EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next();

  try {
    const url = new URL(origin);

    // localhost is a development affordance, not an origin the deployment
    // configured. The CORS allowlist has always drawn that line; this
    // middleware used to allow it in production too, which meant the check
    // that exists to reject unconfigured origins accepted one by name.
    if (process.env.NODE_ENV !== 'production' && isLocalDevHost(url.hostname)) return next();

    // Compare the ORIGIN, not the hostname. Hostname-only made `http://` and
    // `https://` interchangeable, so a plaintext page on the real host — what
    // an active network attacker can actually serve — passed the same check
    // as the TLS site.
    if (allowedOriginSet().has(url.origin)) return next();

    logger.warn({ origin: url.origin, path: req.path }, 'Origin check failed');
    return res.status(403).json({ error: 'Forbidden' });
  } catch {
    // Invalid URL in origin/referer — just log and deny
    logger.warn({ origin: origin, path: req.path }, 'Invalid origin header');
    return res.status(400).json({ error: 'Invalid request' });
  }
}

module.exports = { originCheck };
