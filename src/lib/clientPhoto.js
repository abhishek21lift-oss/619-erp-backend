'use strict';
// A client's profile photo, checked.
//
// pt_clients.photo_url stores the photo as a data URL. The member's own upload
// (client-portal setMyPhoto) checked the bytes; the trainer's upload
// (POST /pt-os/clients/:id/photo) and PATCH photo_url stored whatever string
// arrived — any size up to the 4 MB body limit, any claimed type, or text that
// was not an image at all. Both now go through this one rule: a JPEG, PNG or
// WebP, identified by its signature rather than its claimed type, under 1 MB.
// The app crops and downscales to 800 px first, which comes in well under it.

const { detectFileType, LOGO_IMAGES } = require('./fileSignatures');

const PHOTO_MAX_BYTES = 1024 * 1024;
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

class PhotoInputError extends Error {}

/**
 * @param {unknown} raw  a data URL
 * @returns {string}     the data URL, re-labelled with the DETECTED type
 * @throws {PhotoInputError} with a message fit to show the person uploading
 */
function parseClientPhoto(raw) {
  const m = typeof raw === 'string' ? DATA_URL_RE.exec(raw) : null;
  if (!m) throw new PhotoInputError('Use a JPG, PNG or WebP photo.');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length === 0) throw new PhotoInputError('The photo is empty.');
  if (bytes.length > PHOTO_MAX_BYTES) throw new PhotoInputError('The photo is too large — pick a smaller one.');
  const detected = detectFileType(bytes, LOGO_IMAGES);
  if (!detected) throw new PhotoInputError('That file is not a JPG, PNG or WebP image.');
  return `data:${detected.mime};base64,${m[2]}`;
}

module.exports = { parseClientPhoto, PhotoInputError, PHOTO_MAX_BYTES };
