'use strict';

/**
 * Numeric request fields that do not silently become zero.
 *
 * `z.coerce.number()` is `Number()` with a schema around it, and `Number()`
 * treats four different kinds of "no value" as `0`:
 *
 *     z.coerce.number().min(0).parse('')      →  0
 *     z.coerce.number().min(0).parse('   ')   →  0
 *     z.coerce.number().min(0).parse(null)    →  0
 *     z.coerce.number().min(0).parse([])      →  0
 *     z.coerce.number().min(0).parse(true)    →  1
 *
 * Measured against this repo's own Zod, not assumed. Only `'abc'` is rejected.
 *
 * A `.min(5)` floor accidentally protects a field, because 0 fails it. A
 * `.min(0)` floor does not, and those are the fields where zero is a
 * meaningful, wrong answer:
 *
 *     gst_percent   min(0)  →  a blank saves 0% GST onto every invoice
 *     base_amount   min(0)  →  a blank creates a ₹0 payment order
 *     height/weight optional →  a blank becomes 0, and the scoring libraries
 *                              compute a BMI from it without complaint
 *
 * So these helpers separate ABSENT from ZERO, the same distinction the
 * frontend's `normalize.ts` makes, for the same reason: "nothing was supplied"
 * and "the supplied value is zero" are different facts, and a tax rate of 0%
 * that nobody chose is indistinguishable from one that somebody did.
 *
 * What they accept: a JS number, or a string that is entirely a number.
 * What they reject: everything else, including the four values above.
 * What they treat as absent: `undefined`, `null`, `''` and whitespace — for the
 * `optional` variants only. The required variants reject those too.
 */

const { z } = require('zod');

/** A string that is a number and nothing else. No hex, no exponent, no spaces. */
const NUMERIC_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/**
 * Parse one value strictly.
 *
 * @returns {{ ok: true, value: number } | { ok: false, reason: 'absent' | 'invalid' }}
 */
function parseStrict(raw) {
  if (raw === undefined || raw === null) return { ok: false, reason: 'absent' };

  if (typeof raw === 'number') {
    // NaN and ±Infinity are numbers to `typeof` and are not values anyone
    // typed. Infinity also serializes to `null` in JSON, so letting it through
    // means the database receives a null for what the caller sent as a number.
    return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false, reason: 'invalid' };
  }

  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' };

  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'absent' };
  if (!NUMERIC_TEXT.test(trimmed)) return { ok: false, reason: 'invalid' };

  const n = Number(trimmed);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: 'invalid' };
}

/**
 * A required number.
 *
 * Absent and invalid are reported differently, because they are different
 * mistakes and a client shown "must be a number" for a field it never sent
 * goes looking for a typo that does not exist.
 */
function strictNumber({ label = 'value', min, max, int = false } = {}) {
  // `.optional()` before the transform, because in Zod 4 a bare
  // `z.unknown().transform()` is treated as NON-optional: an absent key fails
  // with "expected nonoptional, received undefined" before the transform runs,
  // so the field could never report its own "is required" message — and a
  // genuinely optional sibling could not be omitted at all. Absence is handled
  // inside the transform, where it can be told apart from invalid.
  return z.unknown().optional().transform((raw, ctx) => {
    const parsed = parseStrict(raw);

    if (!parsed.ok) {
      ctx.addIssue({
        code: 'custom',
        message: parsed.reason === 'absent'
          ? `${label} is required`
          : `${label} must be a number`,
      });
      return z.NEVER;
    }

    if (int && !Number.isInteger(parsed.value)) {
      ctx.addIssue({ code: 'custom', message: `${label} must be a whole number` });
      return z.NEVER;
    }
    if (min !== undefined && parsed.value < min) {
      ctx.addIssue({ code: 'custom', message: `${label} must be at least ${min}` });
      return z.NEVER;
    }
    if (max !== undefined && parsed.value > max) {
      ctx.addIssue({ code: 'custom', message: `${label} must be ${max} or less` });
      return z.NEVER;
    }

    return parsed.value;
  });
}

/**
 * An optional number: absent stays `null`, never `0`.
 *
 * The distinction this preserves is the whole point. A client body with
 * `weight: ''` means the field was left blank, and storing 0 kg for it hands
 * the scoring libraries a number to compute a BMI from.
 */
function optionalNumber({ label = 'value', min, max, int = false } = {}) {
  // See strictNumber: without `.optional()` an omitted key is a hard failure,
  // which would make this the opposite of optional.
  return z.unknown().optional().transform((raw, ctx) => {
    const parsed = parseStrict(raw);

    if (!parsed.ok) {
      if (parsed.reason === 'absent') return null;
      ctx.addIssue({ code: 'custom', message: `${label} must be a number` });
      return z.NEVER;
    }

    if (int && !Number.isInteger(parsed.value)) {
      ctx.addIssue({ code: 'custom', message: `${label} must be a whole number` });
      return z.NEVER;
    }
    if (min !== undefined && parsed.value < min) {
      ctx.addIssue({ code: 'custom', message: `${label} must be at least ${min}` });
      return z.NEVER;
    }
    if (max !== undefined && parsed.value > max) {
      ctx.addIssue({ code: 'custom', message: `${label} must be ${max} or less` });
      return z.NEVER;
    }

    return parsed.value;
  });
}

/**
 * On GST slabs, and why they are NOT enforced here.
 *
 * GST is statutory — 0, 5, 12, 18 or 28 — and a 14% invoice is not a slightly
 * wrong tax, it is an invalid tax document. So the frontend constrains the
 * field to those five values, where a studio can see the list and pick from it.
 *
 * This endpoint deliberately does not, and the reason is blast radius: any
 * studio that already saved a non-slab rate through the old free-text field
 * would be unable to save ANY payment setting, including an unrelated UPI ID
 * change, until they noticed and corrected a number they were never told was
 * wrong. Bricking an existing record to enforce a rule retroactively is worse
 * than the rule being enforced only where it can be explained.
 *
 * What IS fixed here is the silent one: a blank no longer becomes 0%.
 *
 * Tightening this to the slabs is a data migration plus a decision, not a
 * validator change, and it belongs with whoever owns the tax position.
 */

module.exports = { strictNumber, optionalNumber, parseStrict };
