'use strict';

/**
 * What a studio offer is allowed to be.
 *
 * This exists because `/api/offers` accepted whatever it was sent. The insert
 * read `discount_type || 'percent'` and `discount_value || 0` and stored the
 * result, with no enum check and no range check — so a 500% discount, a
 * negative amount, or a `discount_type` of `"gift"` were all persistable.
 *
 * The platform's own coupon endpoint (super-admin/subscriptions.js) already
 * validates exactly this: type in a fixed set, value greater than zero, percent
 * capped at 100. Two discount systems with two standards is how a rule ends up
 * enforced on the path nobody uses and absent on the path studios use daily.
 * These are the same rules, applied to the studio-facing side.
 *
 * ── The pairing rule ────────────────────────────────────────────────────────
 *
 * The defect that prompted this is not a range, it is a **pair**. The offers
 * form hides the value input when the type is `free`, but never clears the
 * value, so:
 *
 *     choose Percentage → type 30 → switch to Free → save
 *     ⇒ { discount_type: 'free', discount_value: 30 }
 *
 * Both fields are individually plausible. Only the combination is wrong, which
 * is why no per-field check would have caught it and why this module validates
 * the record rather than the fields.
 *
 * `free` is normalised to a value of 0 rather than rejected when it arrives
 * carrying one. A complimentary offer whose stored value is 30 is a landmine:
 * whoever later reads `discount_value` — a report, a redemption, a person — has
 * no way to know the 30 was never meant to apply.
 */

/** The discount types a studio offer may carry. */
const DISCOUNT_TYPES = Object.freeze(['percent', 'flat', 'free']);

/** The lifecycle states an offer may be in. */
const OFFER_STATUSES = Object.freeze(['active', 'expired', 'draft']);

/**
 * A typo ceiling on a flat discount, not a business limit.
 *
 * Above any real offer and below the point where a stray keypress turns ₹500
 * into ₹500000000.
 */
const MAX_FLAT_DISCOUNT = 10_000_000;

/** Returned by every failure path so callers can shape one consistent response. */
function invalid(message, field) {
  return { ok: false, message, field };
}

/**
 * Parse a numeric field from a JSON body.
 *
 * Mirrors the frontend normalizer deliberately: absent is `null`, present but
 * unparseable is an error, and `''` is absent rather than zero. A request body
 * is JSON so `''` is less likely than it is in a form, but it is exactly what a
 * hand-rolled client sends for a cleared field, and `Number('')` is 0 here for
 * the same reason it is there.
 */
function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return { present: false, value: null };
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? { present: true, value: raw }
      : { present: true, value: NaN };
  }
  if (typeof raw !== 'string') return { present: true, value: NaN };
  const trimmed = raw.trim();
  if (trimmed === '') return { present: false, value: null };
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return { present: true, value: NaN };
  const n = Number(trimmed);
  return { present: true, value: Number.isFinite(n) ? n : NaN };
}

/** Round to two decimals through a scaled integer, as the frontend does. */
function round2(n) {
  return Math.round((n + Number.EPSILON * Math.sign(n)) * 100) / 100;
}

/**
 * Validate a complete offer record and return the values to store.
 *
 * Takes the **merged** record — for an update that means the existing row with
 * the request's changes applied, not the request alone. Validating the request
 * alone is how a type change to `free` slips past while the stored value stays
 * at 30: neither field is wrong in isolation, and the request may not even
 * mention the value.
 *
 * @param {object} record
 * @returns {{ ok: true, value: object } | { ok: false, message: string, field?: string }}
 */
function validateOffer(record) {
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (title === '') return invalid('title is required', 'title');
  if (title.length > 160) return invalid('title must be 160 characters or fewer', 'title');

  const discountType = record.discount_type ?? 'percent';
  if (!DISCOUNT_TYPES.includes(discountType)) {
    return invalid(`discount_type must be one of ${DISCOUNT_TYPES.join(', ')}`, 'discount_type');
  }

  const parsedValue = parseNumber(record.discount_value);
  if (parsedValue.present && Number.isNaN(parsedValue.value)) {
    return invalid('discount_value must be a number', 'discount_value');
  }

  let discountValue;

  if (discountType === 'free') {
    // Normalised, not rejected — see the header. A complimentary offer carries
    // no monetary value, whatever the client sent.
    discountValue = 0;
  } else if (!parsedValue.present) {
    return invalid(
      `discount_value is required when discount_type is '${discountType}'`,
      'discount_value',
    );
  } else if (discountType === 'percent') {
    const v = round2(parsedValue.value);
    if (v <= 0) return invalid('discount_value must be greater than 0', 'discount_value');
    if (v > 100) {
      return invalid('discount_value must be 100 or less for a percentage offer', 'discount_value');
    }
    discountValue = v;
  } else {
    const v = round2(parsedValue.value);
    if (v <= 0) return invalid('discount_value must be greater than 0', 'discount_value');
    if (v > MAX_FLAT_DISCOUNT) {
      return invalid(`discount_value must be ${MAX_FLAT_DISCOUNT} or less`, 'discount_value');
    }
    discountValue = v;
  }

  const parsedUses = parseNumber(record.max_uses);
  let maxUses = null;
  if (parsedUses.present) {
    if (Number.isNaN(parsedUses.value)) {
      return invalid('max_uses must be a number', 'max_uses');
    }
    if (!Number.isInteger(parsedUses.value)) {
      return invalid('max_uses must be a whole number', 'max_uses');
    }
    if (parsedUses.value < 1) {
      // A zero-use offer is not an offer; it is an offer nobody can redeem,
      // which is what `status: 'draft'` is for.
      return invalid('max_uses must be at least 1', 'max_uses');
    }
    maxUses = parsedUses.value;
  }

  const status = record.status ?? 'active';
  if (!OFFER_STATUSES.includes(status)) {
    return invalid(`status must be one of ${OFFER_STATUSES.join(', ')}`, 'status');
  }

  const validFrom = normaliseDate(record.valid_from);
  const validUntil = normaliseDate(record.valid_until);
  if (validFrom === false) return invalid('valid_from must be a date (YYYY-MM-DD)', 'valid_from');
  if (validUntil === false) {
    return invalid('valid_until must be a date (YYYY-MM-DD)', 'valid_until');
  }
  if (validFrom && validUntil && validUntil < validFrom) {
    // ISO dates compare correctly as strings, which keeps timezones out of it.
    return invalid('valid_until cannot be before valid_from', 'valid_until');
  }

  const code = normaliseCode(record.code);
  if (code === false) {
    return invalid('code may use letters, numbers, hyphens and underscores only', 'code');
  }

  const description =
    typeof record.description === 'string' && record.description.trim() !== ''
      ? record.description.trim()
      : null;

  const audience =
    typeof record.audience === 'string' && record.audience.trim() !== ''
      ? record.audience.trim()
      : 'all';

  return {
    ok: true,
    value: {
      title,
      description,
      discount_type: discountType,
      discount_value: discountValue,
      code,
      audience,
      max_uses: maxUses,
      valid_from: validFrom,
      valid_until: validUntil,
      status,
    },
  };
}

/**
 * `YYYY-MM-DD`, `null` for absent, `false` for unparseable.
 *
 * Reconstructs the date rather than trusting `new Date()`, which rolls
 * 2026-02-31 forward to 3 March and would store a date nobody chose. A `Date`
 * instance is read in UTC because that is how node-postgres hands back a DATE
 * column, and those carry no meaningful local time.
 */
function normaliseDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  let s;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return false;
    s = raw.toISOString().slice(0, 10);
  } else if (typeof raw === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/.exec(raw.trim());
    if (!m) return false;
    s = m[1];
  } else {
    return false;
  }

  const [y, mo, d] = s.split('-').map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  const real =
    probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
  return real ? s : false;
}

/** Uppercased and compacted, `null` for absent, `false` for illegal characters. */
function normaliseCode(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return false;
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (compact === '') return null;
  if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(compact)) return false;
  return compact;
}

module.exports = {
  validateOffer,
  DISCOUNT_TYPES,
  OFFER_STATUSES,
  MAX_FLAT_DISCOUNT,
};
