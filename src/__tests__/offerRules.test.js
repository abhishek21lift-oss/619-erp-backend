'use strict';

/**
 * The offer rules, with the pairing bug pinned from both sides.
 *
 * `/api/offers` previously stored whatever it was sent: `discount_type ||
 * 'percent'` and `discount_value || 0`, no enum, no range. These tests are
 * written against the combinations that were persistable, so a regression
 * shows up as a named failure rather than as a strange number on a report.
 */

const { validateOffer, DISCOUNT_TYPES, MAX_FLAT_DISCOUNT } = require('../lib/offerRules');

/** A minimal valid record, for tests that vary one thing. */
function base(overrides = {}) {
  return {
    title: 'Summer Splash',
    discount_type: 'percent',
    discount_value: 30,
    ...overrides,
  };
}

describe('validateOffer — the free/value pairing', () => {
  // The defect: the form hides the value input for a `free` offer but never
  // clears the value, so percent → 30 → free submits { free, 30 }. Both fields
  // are individually plausible; only the pair is wrong.
  test('a free offer carrying a stale value is normalised to zero, not stored', () => {
    const r = validateOffer(base({ discount_type: 'free', discount_value: 30 }));
    expect(r.ok).toBe(true);
    expect(r.value.discount_type).toBe('free');
    expect(r.value.discount_value).toBe(0);
  });

  test('a free offer with no value at all is fine', () => {
    const r = validateOffer({ title: 'Comp', discount_type: 'free' });
    expect(r.ok).toBe(true);
    expect(r.value.discount_value).toBe(0);
  });

  test('a percent or flat offer must carry a value', () => {
    for (const type of ['percent', 'flat']) {
      const r = validateOffer({ title: 'X', discount_type: type });
      expect(r.ok).toBe(false);
      expect(r.field).toBe('discount_value');
      expect(r.message).toContain(type);
    }
  });
});

describe('validateOffer — ranges that were absent', () => {
  test('a percentage above 100 is rejected', () => {
    // The form had min={1} and no max, so 500% was submittable and storable.
    const r = validateOffer(base({ discount_value: 500 }));
    expect(r.ok).toBe(false);
    expect(r.field).toBe('discount_value');
    expect(r.message).toBe('discount_value must be 100 or less for a percentage offer');
  });

  test('exactly 100% is allowed', () => {
    expect(validateOffer(base({ discount_value: 100 })).ok).toBe(true);
  });

  test('zero and negative discounts are rejected for both paid types', () => {
    for (const type of ['percent', 'flat']) {
      for (const value of [0, -1, -0.01]) {
        const r = validateOffer(base({ discount_type: type, discount_value: value }));
        expect(r.ok).toBe(false);
        expect(r.message).toBe('discount_value must be greater than 0');
      }
    }
  });

  test('a flat discount is capped against a keypress slip', () => {
    expect(validateOffer(base({ discount_type: 'flat', discount_value: 500 })).ok).toBe(true);
    const r = validateOffer(base({ discount_type: 'flat', discount_value: MAX_FLAT_DISCOUNT + 1 }));
    expect(r.ok).toBe(false);
  });

  test('an unknown discount_type is rejected rather than defaulted', () => {
    // `discount_type || 'percent'` silently turned a typo into a percentage.
    const r = validateOffer(base({ discount_type: 'gift' }));
    expect(r.ok).toBe(false);
    expect(r.field).toBe('discount_type');
    for (const t of DISCOUNT_TYPES) expect(r.message).toContain(t);
  });
});

describe('validateOffer — numeric coercion', () => {
  test('an empty string is absent, not zero', () => {
    // Number('') === 0 is the coercion this whole layer exists to stop.
    const r = validateOffer(base({ discount_value: '' }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('required');
  });

  test('a non-numeric value is reported as such', () => {
    const r = validateOffer(base({ discount_value: 'thirty' }));
    expect(r.ok).toBe(false);
    expect(r.message).toBe('discount_value must be a number');
  });

  test('Infinity and NaN are rejected', () => {
    for (const bad of [Infinity, -Infinity, NaN, '1e999']) {
      expect(validateOffer(base({ discount_value: bad })).ok).toBe(false);
    }
  });

  test('a numeric string is accepted and rounded to paise', () => {
    expect(validateOffer(base({ discount_value: '12.5' })).value.discount_value).toBe(12.5);
    expect(validateOffer(base({ discount_value: '12.005' })).value.discount_value).toBe(12.01);
  });
});

describe('validateOffer — max_uses', () => {
  test('absent means unlimited', () => {
    expect(validateOffer(base()).value.max_uses).toBe(null);
    expect(validateOffer(base({ max_uses: '' })).value.max_uses).toBe(null);
  });

  test('zero and negative are rejected', () => {
    // A zero-use offer is one nobody can redeem; that is what draft status is.
    for (const bad of [0, -5]) {
      const r = validateOffer(base({ max_uses: bad }));
      expect(r.ok).toBe(false);
      expect(r.field).toBe('max_uses');
    }
  });

  test('a fraction is rejected rather than rounded', () => {
    const r = validateOffer(base({ max_uses: 2.5 }));
    expect(r.ok).toBe(false);
    expect(r.message).toBe('max_uses must be a whole number');
  });
});

describe('validateOffer — dates', () => {
  test('an end before a start is rejected and blamed on the end', () => {
    const r = validateOffer(base({ valid_from: '2026-03-10', valid_until: '2026-03-01' }));
    expect(r.ok).toBe(false);
    expect(r.field).toBe('valid_until');
  });

  test('a single-day offer is allowed', () => {
    expect(validateOffer(base({ valid_from: '2026-03-01', valid_until: '2026-03-01' })).ok).toBe(true);
  });

  test('a date that does not exist is rejected, not rolled forward', () => {
    // new Date('2026-02-31') becomes 3 March, which would store a date the
    // studio never chose.
    expect(validateOffer(base({ valid_from: '2026-02-31' })).ok).toBe(false);
    expect(validateOffer(base({ valid_from: '2024-02-29' })).ok).toBe(true); // leap year
    expect(validateOffer(base({ valid_from: '2026-02-29' })).ok).toBe(false);
  });

  test('absent dates stay null', () => {
    const r = validateOffer(base({ valid_from: '', valid_until: null }));
    expect(r.value.valid_from).toBe(null);
    expect(r.value.valid_until).toBe(null);
  });
});

describe('validateOffer — code and title', () => {
  test('a code is uppercased and compacted', () => {
    expect(validateOffer(base({ code: ' summer 30 ' })).value.code).toBe('SUMMER30');
  });

  test('an illegal code is rejected', () => {
    const r = validateOffer(base({ code: 'SUM!MER' }));
    expect(r.ok).toBe(false);
    expect(r.field).toBe('code');
  });

  test('no code means no code', () => {
    expect(validateOffer(base({ code: '' })).value.code).toBe(null);
    expect(validateOffer(base()).value.code).toBe(null);
  });

  test('a blank title is rejected however it is blank', () => {
    for (const bad of ['', '   ', null, undefined]) {
      const r = validateOffer(base({ title: bad }));
      expect(r.ok).toBe(false);
      expect(r.field).toBe('title');
    }
  });
});

describe('validateOffer — status and audience', () => {
  test('an unknown status is rejected', () => {
    expect(validateOffer(base({ status: 'paused' })).ok).toBe(false);
    for (const s of ['active', 'expired', 'draft']) {
      expect(validateOffer(base({ status: s })).ok).toBe(true);
    }
  });

  test('audience defaults to all', () => {
    expect(validateOffer(base()).value.audience).toBe('all');
    expect(validateOffer(base({ audience: 'Quarterly' })).value.audience).toBe('Quarterly');
  });
});

describe('validateOffer — the merged-record contract', () => {
  test('validates the pair even when only the type is changing', () => {
    // This is the PUT case: the request says {discount_type:'free'} and nothing
    // else, and the stored row still has 30. The route merges before calling
    // this, so the stale value is seen and normalised.
    const stored = { title: 'Summer', discount_type: 'percent', discount_value: 30 };
    const merged = { ...stored, discount_type: 'free' };
    const r = validateOffer(merged);
    expect(r.ok).toBe(true);
    expect(r.value.discount_value).toBe(0);
  });

  test('a type change to percent re-checks the stored value against the new range', () => {
    const stored = { title: 'Flat 5000', discount_type: 'flat', discount_value: 5000 };
    const merged = { ...stored, discount_type: 'percent' };
    const r = validateOffer(merged);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('100 or less');
  });
});
