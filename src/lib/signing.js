'use strict';
// What a captured signature must be, and how a signing device is described.
// Shared by Informed Consent and the PAR-Q consent so the two legal records
// cannot disagree about either.

const { z } = require('./validation');

/**
 * A signature as the signature pad produces it: a PNG data URL.
 *
 * It used to be any non-empty string. Anything else reached the PDF embed,
 * threw there, and the throw was swallowed — so a "completed" consent could
 * have no PDF. Every signature in production is a PNG data URL (the largest
 * 53 KB), so this rejects nothing real. The ceiling bounds a 4mb body to one
 * plausible signature rather than four megabytes of base64.
 */
const SIGNATURE_MAX_CHARS = 1_500_000;
const SIGNATURE_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

const signatureDataUrl = z.string()
  .max(SIGNATURE_MAX_CHARS, 'Signature image is too large')
  .regex(SIGNATURE_PATTERN, 'Signature must be a PNG image from the signature pad');

/**
 * Device and browser for the audit trail of a signed record.
 *
 * Order matters: Edge's user agent also says "Chrome" and "Safari", and
 * Chrome's also says "Safari", so the most specific token is tested first.
 * Edge used to be recorded as Chrome on every consent.
 */
function describeAgent(userAgent) {
  const ua = String(userAgent || '');
  const device = /Mobile|Android|iPhone/i.test(ua) ? 'mobile' : /iPad|Tablet/i.test(ua) ? 'tablet' : 'desktop';
  const browser = /Edg(e|A|iOS)?\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /SamsungBrowser/i.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/i.test(ua) ? 'Firefox'
    : /Chrome|CriOS/i.test(ua) ? 'Chrome'
    : /Safari/i.test(ua) ? 'Safari'
    : 'Browser';
  return { device, browser };
}

module.exports = { signatureDataUrl, SIGNATURE_PATTERN, SIGNATURE_MAX_CHARS, describeAgent };
