// A coach's bio is written in a textarea. It used to arrive as one paragraph.
//
// `cleanText` collapses every run of whitespace — newlines included — into a
// single space, and the profile route used it for `bio`, `philosophy`,
// `training_style` and an achievement's `detail`. All four are multi-line
// fields in the UI: the bio box is four rows with a 2000-character budget.
// Someone would write three paragraphs, save, and watch them merge, with
// nothing they could have typed differently to prevent it.
//
// These tests pin both halves of the fix: newlines survive, and for any value
// WITHOUT a newline the output is still character-for-character what
// `cleanText` produced — which is what makes it safe on columns already full
// of single-line text.

const { cleanText, cleanMultilineText } = require('../lib/credentials');
const { validateAchievements, LIMITS } = require('../lib/profileFields');

describe('cleanMultilineText', () => {
  test('keeps the paragraph breaks a textarea invites', () => {
    const bio = 'I coach strength athletes.\n\nTwelve years, mostly powerlifting.';
    expect(cleanMultilineText(bio, 2000)).toBe(bio);
  });

  test('collapses spaces and tabs within a line, as cleanText always did', () => {
    expect(cleanMultilineText('one   two\tthree', 100)).toBe('one two three');
  });

  test('trims each line, so a trailing space before Enter does not persist', () => {
    expect(cleanMultilineText('  first  \n  second  ', 100)).toBe('first\nsecond');
  });

  test('normalises CRLF, so a Windows paste is not double-spaced', () => {
    expect(cleanMultilineText('a\r\nb\rc', 100)).toBe('a\nb\nc');
  });

  test('caps a run of blank lines at one — leaning on Enter is not a wider gap', () => {
    expect(cleanMultilineText('a\n\n\n\n\nb', 100)).toBe('a\n\nb');
  });

  test('still truncates to the column budget', () => {
    expect(cleanMultilineText('x'.repeat(50), 10)).toBe('x'.repeat(10));
  });

  test('treats null and undefined as empty, as cleanText does', () => {
    expect(cleanMultilineText(null, 10)).toBe('');
    expect(cleanMultilineText(undefined, 10)).toBe('');
  });

  // The backward-compatibility guarantee, stated as an assertion rather than a
  // comment: single-line values must not change shape at all.
  test.each([
    '  hello   world  ',
    'a\tb',
    '',
    '   ',
    'NASM Certified Personal Trainer',
    'x'.repeat(300),
  ])('matches cleanText exactly for single-line input %p', (value) => {
    expect(cleanMultilineText(value, 140)).toBe(cleanText(value, 140));
  });
});

describe("an achievement's detail", () => {
  test('keeps its line breaks through validateAchievements', () => {
    const detail = 'Snatch 92kg.\nClean & jerk 115kg.';
    const { value } = validateAchievements([
      { id: 'a1', title: 'National championship', kind: 'competition', year: 2024, detail },
    ]);
    expect(value[0].detail).toBe(detail);
  });

  test('is still capped at the column budget', () => {
    const { value } = validateAchievements([
      { id: 'a1', title: 'Long one', kind: 'other', year: null, detail: 'y'.repeat(LIMITS.detail + 50) },
    ]);
    expect(value[0].detail).toHaveLength(LIMITS.detail);
  });
});
