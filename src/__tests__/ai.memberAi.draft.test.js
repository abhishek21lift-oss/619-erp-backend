'use strict';
// A draft is protocol, not answer: the member must never see the marker, and a
// marker split across two SSE chunks must not leak `[[DRA` into the text.
const { visibleDuringStream, extractDraft, DRAFT_MARKER } = require('../modules/member-ai/member-ai.draft');

describe('visibleDuringStream', () => {
  it('passes ordinary text through, including a trailing space', () => {
    expect(visibleDuringStream('Hello ')).toBe('Hello ');
  });

  it('withholds a partial marker at the end of a chunk', () => {
    expect(visibleDuringStream('Answer [[DRA')).toBe('Answer');
    expect(visibleDuringStream('Answer [[DRAFT')).toBe('Answer');
  });

  it('withholds the marker and everything after it', () => {
    expect(visibleDuringStream('Answer [[DRAFT]]{"proposedMessage":"Hi"}')).toBe('Answer');
  });
});

describe('extractDraft', () => {
  it('parses a valid trailing block', () => {
    expect(extractDraft('Answer [[DRAFT]]{"proposedMessage":"Hi trainer"}')).toEqual({
      visible: 'Answer', draft: 'Hi trainer',
    });
  });

  it('returns no draft for malformed JSON, and keeps the visible answer', () => {
    expect(extractDraft('Answer [[DRAFT]]not json')).toEqual({ visible: 'Answer', draft: null });
  });

  it('returns no draft when the marker is absent', () => {
    expect(extractDraft('Just an answer')).toEqual({ visible: 'Just an answer', draft: null });
  });

  it('rejects an empty or over-long draft', () => {
    expect(extractDraft('A [[DRAFT]]{"proposedMessage":"   "}').draft).toBeNull();
    expect(extractDraft(`A [[DRAFT]]{"proposedMessage":"${'x'.repeat(801)}"}`).draft).toBeNull();
  });

  it('exports the exact marker the prompt uses', () => {
    expect(DRAFT_MARKER).toBe('[[DRAFT]]');
  });
});
