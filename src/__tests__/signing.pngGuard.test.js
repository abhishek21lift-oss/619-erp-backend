'use strict';
// Signatures are fully decoded before pdfkit sees them (security audit
// 2026-10-08). pdfkit's PNG decoder fails asynchronously, outside any
// try/catch, which exits the process; isRenderableSignaturePng does the same
// work synchronously so an unreadable image is a 400 or a "(could not be
// rendered)" line in the PDF — never a crash.

const { isRenderableSignaturePng, signatureDataUrl, MAX_SIGNATURE_PX } = require('../lib/signing');

// A real 1x1 RGBA PNG, as a canvas would export.
const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const good = () => Buffer.from(B64, 'base64');
const IHDR_DATA = 16; // 8 magic + 4 length + 4 type
const IDAT_DATA = 8 + 25 + 8; // after the 25-byte IHDR chunk: length + type

test('accepts what a signature pad produces', () => {
  expect(isRenderableSignaturePng(good())).toBe(true);
  expect(signatureDataUrl.safeParse(`data:image/png;base64,${B64}`).success).toBe(true);
});

test.each([
  ['not a buffer', () => 'nope'],
  ['truncated', () => good().subarray(0, 40)],
  ['compressed pixel data that does not inflate', () => { const b = good(); b[IDAT_DATA] ^= 0xff; b[IDAT_DATA + 1] ^= 0xff; return b; }],
  ['a declared width beyond any signature pad', () => { const b = good(); b.writeUInt32BE(MAX_SIGNATURE_PX.width + 1, IHDR_DATA); return b; }],
  ['a declared size the pixel data does not match', () => { const b = good(); b.writeUInt32BE(2, IHDR_DATA); return b; }],
  ['16-bit depth', () => { const b = good(); b[IHDR_DATA + 8] = 16; return b; }],
  ['interlaced', () => { const b = good(); b[IHDR_DATA + 12] = 1; return b; }],
])('rejects %s', (_label, make) => {
  expect(isRenderableSignaturePng(make())).toBe(false);
});

test('the zod schema refuses a data URL whose image cannot be decoded', () => {
  const b = good(); b[IDAT_DATA] ^= 0xff; b[IDAT_DATA + 1] ^= 0xff;
  expect(signatureDataUrl.safeParse(`data:image/png;base64,${b.toString('base64')}`).success).toBe(false);
});

test('a stored unreadable signature is never handed to pdfkit', () => {
  const { embedSignature } = require('../lib/pdfHelpers');
  const calls = [];
  const doc = new Proxy({}, {
    get: (_t, prop) => (...args) => { calls.push(prop); if (prop === 'image') throw new Error('should not be called'); return doc; },
  });
  const b = good(); b[IDAT_DATA] ^= 0xff; b[IDAT_DATA + 1] ^= 0xff;
  embedSignature(doc, 'Client Signature:', `data:image/png;base64,${b.toString('base64')}`);
  expect(calls).not.toContain('image');
  embedSignature(doc, 'Client Signature:', `data:image/png;base64,${B64}`);
  expect(calls).toContain('image');
});
