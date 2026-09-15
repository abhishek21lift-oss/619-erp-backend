'use strict';

/**
 * What an uploaded file actually is, according to its bytes.
 *
 * Multer's `fileFilter` reads `file.mimetype`, and that value comes from the
 * `Content-Type` header of the multipart part — i.e. from the client. It is a
 * cheap first rejection and it is not evidence: a request can declare
 * `image/png` over arbitrary content. Every upload route in this codebase
 * already knew that and sniffed the leading bytes afterwards.
 *
 * The problem was that each one sniffed with its own private copy of the table,
 * and five copies of a security check drift. They had:
 *
 *   routes/profile.js                 jpg png gif webp   ← the correct one
 *   routes/upi-payments.js            jpg png pdf
 *   modules/pt-os/parq.routes.js      jpg png pdf
 *   modules/pt-os/informed-consent    jpg png pdf
 *   platform/super-admin/shared.js    jpg png webp       ← and this one was wrong
 *
 * ── The divergence ──────────────────────────────────────────────────────────
 *
 * WebP is a RIFF container, so its first four bytes are `RIFF` — which is also
 * the first four bytes of WAV and AVI. Identifying WebP needs the format word
 * at offset 8 as well. `profile.js` checked it. `super-admin/shared.js` did
 * not, so any RIFF file — a .wav, a .avi — passed as `image/webp` on the studio
 * logo upload and was stored and served under an image content type.
 *
 * That is not code execution: the object is served as `image/webp` from the
 * uploads path, so a browser refuses to render it rather than running it. It is
 * arbitrary binary accepted into storage and served as an image, which is worth
 * closing on its own and is exactly the failure mode that five copies produce.
 *
 * So there is now one table and one detector, and the per-route difference is
 * expressed as which formats that route ALLOWS rather than as a separate
 * implementation of what the formats are.
 */

/**
 * `magic` is matched at offset 0. `formatWord`, when present, is matched at its
 * own offset and must also match — a container's outer magic is not an
 * identification on its own.
 */
const SIGNATURES = Object.freeze({
  jpg: Object.freeze({
    mime: 'image/jpeg',
    ext: 'jpg',
    // Only the SOI marker and the first byte of the next segment are fixed; the
    // fourth byte varies by encoder (JFIF / Exif / raw), so it is not checked.
    magic: Object.freeze([0xff, 0xd8, 0xff]),
  }),
  png: Object.freeze({
    mime: 'image/png',
    ext: 'png',
    magic: Object.freeze([0x89, 0x50, 0x4e, 0x47]),
  }),
  gif: Object.freeze({
    mime: 'image/gif',
    ext: 'gif',
    magic: Object.freeze([0x47, 0x49, 0x46, 0x38]),
  }),
  webp: Object.freeze({
    mime: 'image/webp',
    ext: 'webp',
    magic: Object.freeze([0x52, 0x49, 0x46, 0x46]), // "RIFF"
    // "WEBP" at byte 8. Without this a .wav or .avi is indistinguishable.
    formatWord: Object.freeze({ offset: 8, bytes: Object.freeze([0x57, 0x45, 0x42, 0x50]) }),
  }),
  pdf: Object.freeze({
    mime: 'application/pdf',
    ext: 'pdf',
    magic: Object.freeze([0x25, 0x50, 0x44, 0x46]), // "%PDF"
  }),
});

/** The sets the routes actually use, named so a route declares intent. */
const PROFILE_IMAGES = Object.freeze([
  SIGNATURES.jpg, SIGNATURES.png, SIGNATURES.gif, SIGNATURES.webp,
]);

/** Logos: no GIF — an animated logo is not a product feature. */
const LOGO_IMAGES = Object.freeze([SIGNATURES.jpg, SIGNATURES.png, SIGNATURES.webp]);

/** Scans and attachments: a photo of a document, or the document. */
const DOCUMENTS = Object.freeze([SIGNATURES.jpg, SIGNATURES.png, SIGNATURES.pdf]);

function matches(buf, sig) {
  if (!buf || buf.length < sig.magic.length) return false;
  for (let i = 0; i < sig.magic.length; i += 1) {
    if (buf[i] !== sig.magic[i]) return false;
  }
  if (sig.formatWord) {
    const { offset, bytes } = sig.formatWord;
    if (buf.length < offset + bytes.length) return false;
    for (let i = 0; i < bytes.length; i += 1) {
      if (buf[offset + i] !== bytes[i]) return false;
    }
  }
  return true;
}

/**
 * Identify a buffer, restricted to `allowed`.
 *
 * @param {Buffer|Uint8Array} buf
 * @param {ReadonlyArray<object>} allowed  one of the sets above
 * @returns {{mime: string, ext: string}|null} null when the bytes match nothing
 *   allowed — which covers both "not a file we accept" and "not the file it
 *   claims to be", deliberately: the caller has no reason to tell a client
 *   which of those it was.
 */
function detectFileType(buf, allowed) {
  if (!Array.isArray(allowed) && !Object.isFrozen(allowed)) return null;
  for (const sig of allowed) {
    if (matches(buf, sig)) return { mime: sig.mime, ext: sig.ext };
  }
  return null;
}

module.exports = {
  SIGNATURES,
  PROFILE_IMAGES,
  LOGO_IMAGES,
  DOCUMENTS,
  detectFileType,
};
