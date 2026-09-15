'use strict';

/**
 * Strict numeric request fields.
 *
 * The first block re-measures `z.coerce.number()` rather than asserting what it
 * ought to do. That is deliberate: this whole module exists because of a
 * behaviour that is easy to assume away, and if a future Zod changes it, this
 * test should tell us rather than quietly agreeing.
 */

const { z } = require('zod');
const { strictNumber, optionalNumber, parseStrict } = require('../lib/zodNumbers');

describe('the behaviour being replaced', () => {
  const coerced = z.coerce.number().min(0).max(100);

  test.each([
    ['empty string', '', 0],
    ['whitespace', '   ', 0],
    ['null', null, 0],
    ['empty array', [], 0],
    ['true', true, 1],
  ])('z.coerce.number() turns %s into %i', (_label, input, expected) => {
    // Not a hypothetical: gst_percent used this with .min(0), so every one of
    // these saved a tax rate nobody chose.
    expect(coerced.parse(input)).toBe(expected);
  });

  test('a .min(5) floor accidentally protects a field, which is why only min(0) fields were exposed', () => {
    expect(z.coerce.number().min(5).safeParse('').success).toBe(false);
    expect(z.coerce.number().min(0).safeParse('').success).toBe(true);
  });
});

describe('strictNumber — required', () => {
  const gst = strictNumber({ label: 'gst_percent', min: 0, max: 100 });

  test.each([['empty string', ''], ['whitespace', '   '], ['null', null],
             ['empty array', []], ['true', true], ['object', {}], ['undefined', undefined]])(
    'refuses %s rather than coercing it', (_label, input) => {
      expect(gst.safeParse(input).success).toBe(false);
    },
  );

  test('separates absent from invalid, because they are different mistakes', () => {
    // "must be a number" for a field the client never sent sends someone
    // looking for a typo that does not exist.
    expect(gst.safeParse('').error.issues[0].message).toBe('gst_percent is required');
    expect(gst.safeParse('abc').error.issues[0].message).toBe('gst_percent must be a number');
  });

  test('accepts a real zero, which is a legitimate GST rate', () => {
    expect(gst.parse(0)).toBe(0);
    expect(gst.parse('0')).toBe(0);
  });

  test('accepts numbers and fully-numeric strings', () => {
    expect(gst.parse(18)).toBe(18);
    expect(gst.parse('18')).toBe(18);
    expect(gst.parse(' 18 ')).toBe(18);
    expect(gst.parse('12.5')).toBe(12.5);
  });

  test.each([['0x10'], ['1e999'], [Infinity], [-Infinity], [NaN]])(
    'refuses %p, which Number() would accept through a non-numeric route',
    (bad) => {
      expect(gst.safeParse(bad).success).toBe(false);
    },
  );

  test('enforces bounds', () => {
    expect(gst.safeParse(101).success).toBe(false);
    expect(gst.safeParse(-1).success).toBe(false);
    expect(gst.safeParse(100).success).toBe(true);
  });

  test('enforces whole numbers when asked, without rounding', () => {
    const months = strictNumber({ label: 'duration_months', min: 1, max: 120, int: true });
    expect(months.safeParse(2.5).error.issues[0].message)
      .toBe('duration_months must be a whole number');
    expect(months.parse(3)).toBe(3);
  });
});

describe('optionalNumber — absent stays null, never zero', () => {
  const weight = optionalNumber({ label: 'weight', min: 20, max: 350 });

  test.each([['empty string', ''], ['whitespace', '  '], ['null', null], ['undefined', undefined]])(
    '%s is absent, not 0', (_label, input) => {
      // A weight of 0 kg reaches the scoring libraries and produces a BMI.
      expect(weight.parse(input)).toBe(null);
    },
  );

  test.each([[[]], [true], ['abc'], [{}]])(
    'still refuses %p, which is present and wrong rather than absent',
    (bad) => {
      expect(weight.safeParse(bad).success).toBe(false);
    },
  );

  test('applies plausibility bounds so a keypress slip cannot reach scoring', () => {
    expect(weight.parse('70')).toBe(70);
    expect(weight.safeParse('700').success).toBe(false); // 70 with a stray zero
    expect(weight.safeParse('5').success).toBe(false);
  });

  test('a real zero still passes where zero is meaningful', () => {
    const discount = optionalNumber({ label: 'discount', min: 0, max: 1000 });
    expect(discount.parse('0')).toBe(0);
    expect(discount.parse('')).toBe(null);
    // The distinction the whole module exists for, in one assertion.
    expect(discount.parse('0')).not.toBe(discount.parse(''));
  });
});

describe('parseStrict', () => {
  test('reports why it refused', () => {
    expect(parseStrict('')).toEqual({ ok: false, reason: 'absent' });
    expect(parseStrict(null)).toEqual({ ok: false, reason: 'absent' });
    expect(parseStrict('abc')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseStrict([])).toEqual({ ok: false, reason: 'invalid' });
    expect(parseStrict(12.5)).toEqual({ ok: true, value: 12.5 });
  });
});
