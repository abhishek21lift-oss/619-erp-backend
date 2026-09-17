'use strict';
// src/modules/messaging/phone.js
//
// Turn a stored phone number into the E.164 digits WhatsApp addresses by.
//
// ── The production failure this exists to prevent ───────────────────────────
//
// Every client mobile in this database is stored the way an Indian studio
// writes one down: ten bare digits, no country code, no '+'. The send path
// passed that string through untouched, and the gateway's toJid() strips
// non-digits and appends '@s.whatsapp.net' — so "8756562310" became the JID
// "8756562310@s.whatsapp.net", which is not that client and is not anybody.
//
// Nothing anywhere said so. Baileys mints a message key for a send to a JID
// that does not exist and resolves normally, so the worker recorded 'sent',
// wrote the provider id, and the studio's log showed a delivered-looking row.
// Eight messages went out that way over eight days and not one of them
// reached a phone. The tell was in the receipts: WhatsApp acknowledges a real
// delivery with an ack the connector turns into whatsapp.message.delivered,
// and across those eight sends exactly zero arrived — while receipts for the
// messages the owner typed by hand on the same account arrived normally, under
// the phone's own id format. A 0-for-8 delivery rate is not a coincidence, it
// is an address that never existed.
//
// So a number that cannot be resolved to E.164 must FAIL here, loudly and
// non-retryably, rather than be sent into the void with a success recorded
// against it. A visible failed row is recoverable; a silent one is not.
//
// ── Why length, and not a leading-91 test ───────────────────────────────────
//
// "Does it already start with the country code" is ambiguous in exactly the
// market this product serves: Indian mobiles start with 6-9, so the perfectly
// ordinary national number 9198765432 begins with 91 and a prefix test would
// read it as an international number missing two digits. Length is not
// ambiguous. A number of the national length is national; a number of
// country-code + national length that starts with the country code is already
// international; an explicit '+' or '00' means the writer said which country
// they meant and is taken at their word.
//
// ── Why this is configuration and not a constant ────────────────────────────
//
// The defaults describe India (country code 91, ten-digit national numbers)
// because that is where every studio on this deployment operates and what
// platformBilling.js already hardcodes. A deployment elsewhere sets the two
// env vars rather than editing this file. It is deliberately NOT a per-studio
// setting yet: that needs a column, a migration and a place in the UI to set
// it, and inventing a silent per-org default would reintroduce the same class
// of bug this file removes.

const logger = require('../../lib/logger');

/** Country code to assume for a number written without one. Digits, no '+'. */
const DEFAULT_COUNTRY_CODE =
  String(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '');

/** How many digits a national number has in that country, excluding the code. */
const NATIONAL_NUMBER_LENGTH =
  Number(process.env.WHATSAPP_NATIONAL_NUMBER_LENGTH || '10');

/**
 * E.164 permits at most 15 digits including the country code, and no
 * real number is shorter than 8. Both bounds are the standard's, not ours.
 */
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

/**
 * @typedef {{ ok: true, e164: string, normalized: boolean }
 *         | { ok: false, reason: string }} NormalizeResult
 */

/**
 * @param {string} raw            Whatever is stored against the recipient.
 * @param {object} [options]
 * @param {string} [options.defaultCountryCode]
 * @param {number} [options.nationalNumberLength]
 * @returns {NormalizeResult} `e164` is canonical E.164 — a leading '+' and
 *   then digits — which is the form the gateway's `to` field documents and the
 *   form Twilio wants after its own `whatsapp:` prefix. `normalized` says
 *   whether a country code had to be added; the caller logs it, because a
 *   deployment where every send needs one has a client list that was captured
 *   without one, which is a data problem worth seeing.
 */
function toE164(raw, options = {}) {
  const countryCode = String(
    options.defaultCountryCode ?? DEFAULT_COUNTRY_CODE
  ).replace(/\D/g, '');
  const nationalLength = Number(
    options.nationalNumberLength ?? NATIONAL_NUMBER_LENGTH
  );

  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };

  const text = String(raw).trim();
  if (!text) return { ok: false, reason: 'empty' };

  // '+' anywhere but the front is not a written international number, it is a
  // typo or two numbers in one field. Neither may be guessed at.
  const plusCount = (text.match(/\+/g) || []).length;
  if (plusCount > 1 || (plusCount === 1 && !text.startsWith('+'))) {
    return { ok: false, reason: 'malformed' };
  }

  const digits = text.replace(/\D/g, '');
  if (!digits) return { ok: false, reason: 'empty' };

  // An explicit '+' or an IDD '00' prefix: the writer stated the country.
  // Taken as given, bounds-checked, never re-guessed.
  const explicitlyInternational = text.startsWith('+') || digits.startsWith('00');
  if (explicitlyInternational) {
    const stated = digits.startsWith('00') ? digits.slice(2) : digits;
    if (stated.length < MIN_E164_DIGITS || stated.length > MAX_E164_DIGITS) {
      return { ok: false, reason: 'out_of_range' };
    }
    if (stated.startsWith('0')) return { ok: false, reason: 'malformed' };
    return { ok: true, e164: `+${stated}`, normalized: false };
  }

  // Already international and written without the '+': the full length AND the
  // country code both have to agree before it is read that way.
  if (
    countryCode &&
    digits.length === countryCode.length + nationalLength &&
    digits.startsWith(countryCode)
  ) {
    return { ok: true, e164: `+${digits}`, normalized: false };
  }

  // A single leading 0 is the domestic trunk prefix — "08756562310" is how a
  // landline-era habit writes the same mobile. Dropped before the length test,
  // so it resolves like the bare form rather than failing as an 11-digit
  // number of no known shape.
  const national = digits.length === nationalLength + 1 && digits.startsWith('0')
    ? digits.slice(1)
    : digits;

  if (countryCode && national.length === nationalLength) {
    const e164 = `${countryCode}${national}`;
    if (e164.length > MAX_E164_DIGITS) return { ok: false, reason: 'out_of_range' };
    return { ok: true, e164: `+${e164}`, normalized: true };
  }

  // Everything else. Not guessed at: see the header — a wrong guess here is a
  // message recorded as sent that no one will ever receive.
  return { ok: false, reason: 'unrecognised_format' };
}

/**
 * The same rule, for a caller that wants a string or nothing.
 *
 * Logs the rejection at warn. A number this cannot resolve is a data problem
 * in a studio's client list, and it is worth one line saying which shape it
 * was — never the number itself, which is a client's personal contact detail.
 */
function toE164OrNull(raw, options = {}) {
  const result = toE164(raw, options);
  if (result.ok) return result.e164;
  logger.warn(
    { reason: result.reason, digit_count: String(raw ?? '').replace(/\D/g, '').length },
    'whatsapp_recipient_not_e164'
  );
  return null;
}

module.exports = {
  toE164,
  toE164OrNull,
  DEFAULT_COUNTRY_CODE,
  NATIONAL_NUMBER_LENGTH,
};
