'use strict';

/**
 * Upload signature detection.
 *
 * Five routes each carried a private copy of this table, and one of them was
 * wrong: the studio-logo upload identified WebP by its outer `RIFF` magic
 * alone, which WAV and AVI also carry. These tests pin the corrected behaviour
 * and, more importantly, pin it in ONE place — the divergence is only
 * impossible while there is one table.
 */

const {
  detectFileType,
  PROFILE_IMAGES,
  LOGO_IMAGES,
  DOCUMENTS,
  SIGNATURES,
} = require('../lib/fileSignatures');

/** Build a buffer with `magic` at offset 0, padded to a realistic length. */
function buf(magic, { size = 64 } = {}) {
  const b = Buffer.alloc(Math.max(size, magic.length));
  Buffer.from(magic).copy(b, 0);
  return b;
}

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];

/** "RIFF" + 4 size bytes + a 4-byte format word. */
const riff = (word) => [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, ...Buffer.from(word, 'ascii')];
const WEBP = riff('WEBP');
const WAVE = riff('WAVE');
const AVI = riff('AVI ');

describe('the bug this consolidation fixes', () => {
  test('a WAV named as a logo is refused, despite sharing WebP’s RIFF magic', () => {
    // The old LOGO_SIGNATURES matched on [0x52,0x49,0x46,0x46] only. RIFF is a
    // container, not a format, so this passed and was stored as image/webp.
    expect(detectFileType(buf(WAVE), LOGO_IMAGES)).toBeNull();
    expect(detectFileType(buf(AVI), LOGO_IMAGES)).toBeNull();
  });

  test('a genuine WebP is still accepted', () => {
    // The fix must not cost the format it was guarding.
    expect(detectFileType(buf(WEBP), LOGO_IMAGES)).toEqual({
      mime: 'image/webp',
      ext: 'webp',
    });
  });

  test('every set that accepts WebP applies the format-word check', () => {
    // The property, rather than the instance: whichever set is asked, a bare
    // RIFF is never a WebP.
    for (const set of [PROFILE_IMAGES, LOGO_IMAGES]) {
      expect(detectFileType(buf(WAVE), set)).toBeNull();
      expect(detectFileType(buf(WEBP), set)).toEqual({ mime: 'image/webp', ext: 'webp' });
    }
  });

  test('a truncated RIFF header cannot pass by running off the end', () => {
    // Only 8 bytes: the format word is not there to check. Reading past the
    // end yields undefined, which must not compare equal to a byte.
    expect(detectFileType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]), LOGO_IMAGES))
      .toBeNull();
  });
});

describe('detection by bytes, not by claim', () => {
  test('identifies each format from its signature', () => {
    expect(detectFileType(buf(JPEG), PROFILE_IMAGES).ext).toBe('jpg');
    expect(detectFileType(buf(PNG), PROFILE_IMAGES).ext).toBe('png');
    expect(detectFileType(buf(GIF), PROFILE_IMAGES).ext).toBe('gif');
    expect(detectFileType(buf(WEBP), PROFILE_IMAGES).ext).toBe('webp');
    expect(detectFileType(buf(PDF), DOCUMENTS).ext).toBe('pdf');
  });

  test('refuses a format the route does not allow, even when it is genuine', () => {
    // A real PDF is not an avatar; a real GIF is not a logo.
    expect(detectFileType(buf(PDF), PROFILE_IMAGES)).toBeNull();
    expect(detectFileType(buf(GIF), LOGO_IMAGES)).toBeNull();
    expect(detectFileType(buf(GIF), DOCUMENTS)).toBeNull();
  });

  test('refuses arbitrary binary whatever it is named', () => {
    // A PE executable, an ELF binary, and an HTML document. Each would carry a
    // declared Content-Type of image/png through multer's fileFilter.
    const MZ = [0x4d, 0x5a, 0x90, 0x00];
    const ELF = [0x7f, 0x45, 0x4c, 0x46];
    const HTML = [0x3c, 0x21, 0x44, 0x4f, 0x43];
    for (const bytes of [MZ, ELF, HTML]) {
      expect(detectFileType(buf(bytes), PROFILE_IMAGES)).toBeNull();
      expect(detectFileType(buf(bytes), DOCUMENTS)).toBeNull();
      expect(detectFileType(buf(bytes), LOGO_IMAGES)).toBeNull();
    }
  });

  test('refuses SVG — a valid image that is also a script host', () => {
    const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"', 'ascii');
    for (const set of [PROFILE_IMAGES, LOGO_IMAGES, DOCUMENTS]) {
      expect(detectFileType(SVG, set)).toBeNull();
    }
  });

  test('handles empty and undersized buffers without throwing', () => {
    for (const set of [PROFILE_IMAGES, LOGO_IMAGES, DOCUMENTS]) {
      expect(detectFileType(Buffer.alloc(0), set)).toBeNull();
      expect(detectFileType(Buffer.from([0xff]), set)).toBeNull();
      expect(detectFileType(null, set)).toBeNull();
      expect(detectFileType(undefined, set)).toBeNull();
    }
  });
});

describe('the sets preserve each route’s previous behaviour', () => {
  // Consolidation must not quietly widen or narrow what a route accepts.
  test('profile images: jpg png gif webp', () => {
    expect(PROFILE_IMAGES.map((s) => s.ext).sort()).toEqual(['gif', 'jpg', 'png', 'webp']);
  });

  test('logos: jpg png webp, no gif', () => {
    expect(LOGO_IMAGES.map((s) => s.ext).sort()).toEqual(['jpg', 'png', 'webp']);
  });

  test('documents: jpg png pdf', () => {
    expect(DOCUMENTS.map((s) => s.ext).sort()).toEqual(['jpg', 'pdf', 'png']);
  });

  test('the table is frozen, so a route cannot mutate a shared signature', () => {
    // Four modules hold references to these. A route that pushed onto one
    // would silently widen every other route.
    expect(Object.isFrozen(SIGNATURES)).toBe(true);
    expect(Object.isFrozen(PROFILE_IMAGES)).toBe(true);
    expect(Object.isFrozen(SIGNATURES.webp.magic)).toBe(true);
  });
});
