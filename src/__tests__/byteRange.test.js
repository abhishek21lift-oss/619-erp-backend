'use strict';

// Video seeking depends on answering `Range: bytes=…` with a 206 and the
// right slice. A range parser is small enough to look obviously correct and
// wrong by one byte at the end, which is why it is pinned here rather than
// checked by eye in the player.

const { parseByteRange } = require('../lib/fileStorage');

describe('parseByteRange', () => {
  const SIZE = 100;

  test('no header or a non-range header means the whole file', () => {
    expect(parseByteRange(undefined, SIZE)).toBeNull();
    expect(parseByteRange('', SIZE)).toBeNull();
    expect(parseByteRange('items=0-1', SIZE)).toBeNull();
    expect(parseByteRange('bytes=0-1,3-4', SIZE)).toBeNull();
  });

  test('start-end, open-ended and suffix ranges', () => {
    expect(parseByteRange('bytes=0-9', SIZE)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=10-', SIZE)).toEqual({ start: 10, end: SIZE - 1 });
    expect(parseByteRange('bytes=-10', SIZE)).toEqual({ start: 90, end: 99 });
  });

  test('an end past the file is clamped, not overflowed', () => {
    expect(parseByteRange('bytes=90-200', SIZE)).toEqual({ start: 90, end: 99 });
  });

  test('a suffix larger than the file starts at zero', () => {
    expect(parseByteRange('bytes=-500', SIZE)).toEqual({ start: 0, end: 99 });
  });

  test('impossible ranges are distinguishable from malformed ones', () => {
    // A real range that cannot be met must be a 416; a malformed header is
    // ignored and the whole file is served.
    expect(parseByteRange('bytes=100-', SIZE)).toEqual({ unsatisfiable: true });
    expect(parseByteRange('bytes=50-10', SIZE)).toEqual({ unsatisfiable: true });
    expect(parseByteRange('bytes=-0', SIZE)).toEqual({ unsatisfiable: true });
    expect(parseByteRange('bytes=abc-', SIZE)).toBeNull();
  });

  test('an empty object has no satisfiable range', () => {
    expect(parseByteRange('bytes=0-0', 0)).toBeNull();
  });
});
