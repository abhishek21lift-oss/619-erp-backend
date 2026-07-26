'use strict';
// Whiteboard service — the pure parts.
//
// The SQL needs a database and is exercised through the routes. What is worth
// pinning here is the logic that stands between a client-supplied canvas
// document and the database:
//
//   1. assertValidDocument. This is the only size/shape guard on a JSONB column
//      that a user can grow without limit. If it stops rejecting, one board can
//      make every read of that board slow forever.
//
//   2. extractText. It walks attacker-controlled JSON. It must never throw —
//      a save that fails because search indexing choked loses a trainer's work,
//      which is far worse than a board that is briefly not searchable.

const svc = require('../modules/whiteboard/whiteboard.service');

describe('assertValidDocument', () => {
  test('accepts a well-formed empty document', () => {
    expect(() => svc.assertValidDocument({ elements: [], appState: {} })).not.toThrow();
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'elements'],
    ['a number', 7],
  ])('rejects %s', (_label, value) => {
    expect(() => svc.assertValidDocument(value)).toThrow(/document must be an object/);
  });

  test('rejects a document whose elements is not an array', () => {
    expect(() => svc.assertValidDocument({ elements: {} }))
      .toThrow(/document.elements must be an array/);
  });

  test('rejects a document over the size ceiling', () => {
    // One oversized text blob is enough; no need to build a realistic board.
    const huge = { elements: [{ type: 'text', text: 'x'.repeat(svc.MAX_DOCUMENT_BYTES + 1024) }] };
    expect(() => svc.assertValidDocument(huge)).toThrow(/document too large/);
  });

  test('measures bytes, not string length, so multi-byte text cannot slip past', () => {
    // '☃' is 3 bytes in UTF-8 but length 1. A .length check would accept this.
    const count = Math.ceil(svc.MAX_DOCUMENT_BYTES / 3) + 1000;
    const doc = { elements: [{ type: 'text', text: '☃'.repeat(count) }] };
    expect(JSON.stringify(doc).length).toBeLessThan(svc.MAX_DOCUMENT_BYTES);
    expect(() => svc.assertValidDocument(doc)).toThrow(/document too large/);
  });

  test('the thrown error carries an HTTP status the route layer can use', () => {
    try {
      svc.assertValidDocument(null);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(svc.WhiteboardError);
      expect(err.status).toBe(422);
      expect(err.code).toBe('INVALID_DOCUMENT');
    }
  });
});

describe('extractText', () => {
  test('collects text elements', () => {
    const doc = { elements: [
      { type: 'text', text: 'Knee pain' },
      { type: 'text', text: 'Week 3' },
    ] };
    expect(svc.extractText(doc)).toBe('Knee pain Week 3');
  });

  test('collects labels bound to shapes, which is where arrow captions live', () => {
    const doc = { elements: [{ type: 'arrow', label: { text: 'hip hinge' } }] };
    expect(svc.extractText(doc)).toBe('hip hinge');
  });

  test('skips deleted elements — Excalidraw tombstones rather than removing', () => {
    const doc = { elements: [
      { type: 'text', text: 'kept' },
      { type: 'text', text: 'removed', isDeleted: true },
    ] };
    expect(svc.extractText(doc)).toBe('kept');
  });

  test('ignores blank and whitespace-only text', () => {
    const doc = { elements: [
      { type: 'text', text: '   ' },
      { type: 'text', text: '' },
      { type: 'text', text: 'real' },
    ] };
    expect(svc.extractText(doc)).toBe('real');
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['no elements key', {}],
    ['elements not an array', { elements: 'nope' }],
    ['null entries', { elements: [null, undefined] }],
    ['primitive entries', { elements: ['x', 3] }],
    ['non-string text', { elements: [{ text: { nested: true } }] }],
    ['null label', { elements: [{ label: null }] }],
  ])('never throws on malformed input: %s', (_label, doc) => {
    expect(() => svc.extractText(doc)).not.toThrow();
    expect(typeof svc.extractText(doc)).toBe('string');
  });

  test('caps its output so one board cannot bloat every index entry', () => {
    const doc = { elements: Array.from({ length: 5000 }, () => ({ text: 'x'.repeat(50) })) };
    expect(svc.extractText(doc).length).toBeLessThanOrEqual(20000);
  });
});

describe('ENTITY_TYPES', () => {
  test('pt_client is supported — it is what phase 1 ships against', () => {
    expect(svc.ENTITY_TYPES).toContain('pt_client');
  });

  test('stays in step with the DB CHECK constraint in migration 111', () => {
    // If these diverge, the API accepts a value Postgres then rejects at write
    // time — a 500 where a 422 belongs.
    expect(svc.ENTITY_TYPES).toEqual([
      'pt_client', 'session', 'exercise', 'staff', 'course', 'consultation',
    ]);
  });
});
