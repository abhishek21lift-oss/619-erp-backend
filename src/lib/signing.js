'use strict';
// What a captured signature must be, and how a signing device is described.
// Shared by Informed Consent and the PAR-Q consent so the two legal records
// cannot disagree about either.

const zlib = require('zlib');
const { z } = require('./validation');

/**
 * Is this buffer a PNG the PDF renderer can embed without failing?
 *
 * Security audit 2026-10-08. pdfkit hands PNGs to png-js, which inflates and
 * unfilters the pixel data ASYNCHRONOUSLY and throws from inside the zlib
 * callback on bad data — outside any try/catch, into uncaughtException, which
 * exits the process. A signature that merely looked like a PNG data URL could
 * therefore restart the API for every studio, and again on every PDF
 * regeneration once stored. This does the same work synchronously, where a
 * failure is just `false`:
 *   · a well-formed chunk stream with IHDR first and IEND last;
 *   · 8-bit, non-interlaced, a colour type png-js handles, and a size a
 *     signature pad produces (bounds the pixel buffer png-js allocates);
 *   · IDAT inflates, to exactly the size IHDR implies, with a valid filter
 *     byte on every row.
 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIGNATURE_PX = { width: 4096, height: 2048 };
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function isRenderableSignaturePng(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 57 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return false;
    let pos = 8;
    let ihdr = null;
    let sawPalette = false;
    let sawEnd = false;
    const idat = [];
    while (pos + 12 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('latin1', pos + 4, pos + 8);
      const dataStart = pos + 8;
      const dataEnd = dataStart + len;
      if (dataEnd + 4 > buf.length) return false;
      if (!ihdr && type !== 'IHDR') return false;
      if (type === 'IHDR') {
        if (ihdr || len !== 13) return false;
        ihdr = {
          width: buf.readUInt32BE(dataStart),
          height: buf.readUInt32BE(dataStart + 4),
          bitDepth: buf[dataStart + 8],
          colorType: buf[dataStart + 9],
          interlace: buf[dataStart + 12],
        };
      } else if (type === 'PLTE') {
        sawPalette = true;
      } else if (type === 'IDAT') {
        idat.push(buf.subarray(dataStart, dataEnd));
      } else if (type === 'IEND') {
        sawEnd = true;
        break;
      }
      pos = dataEnd + 4; // skip CRC
    }
    if (!ihdr || !sawEnd || idat.length === 0) return false;
    const { width, height, bitDepth, colorType, interlace } = ihdr;
    const channels = CHANNELS[colorType];
    if (!channels || bitDepth !== 8 || interlace !== 0) return false;
    if (colorType === 3 && !sawPalette) return false;
    if (width < 1 || height < 1 || width > MAX_SIGNATURE_PX.width || height > MAX_SIGNATURE_PX.height) return false;
    const rowBytes = width * channels;
    const expected = height * (rowBytes + 1);
    // maxOutputLength stops a decompression bomb before it allocates.
    const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
    if (raw.length !== expected) return false;
    for (let row = 0; row < height; row += 1) {
      if (raw[row * (rowBytes + 1)] > 4) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The PNG bytes of a `data:image/png;base64,` URL, or null. */
function signatureBuffer(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

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
  .regex(SIGNATURE_PATTERN, 'Signature must be a PNG image from the signature pad')
  .refine((v) => isRenderableSignaturePng(signatureBuffer(v)), 'Signature image could not be read');

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

module.exports = {
  signatureDataUrl, SIGNATURE_PATTERN, SIGNATURE_MAX_CHARS, describeAgent,
  isRenderableSignaturePng, signatureBuffer, MAX_SIGNATURE_PX,
};
