'use strict';
// Draft marker handling for the member assistant.
//
// The model may end an answer with one protocol line:
//
//   [[DRAFT]]{"proposedMessage":"..."}
//
// The member must never see that line. Streaming makes that harder than a
// single string replace: the marker can be split across two chunks, and a
// half-written `[[DRA` is still protocol text. `visibleDuringStream` therefore
// also withholds a trailing prefix of the marker until the next chunk proves
// it was ordinary text.
//
// This module only reads. The draft is returned to the route as a proposal;
// sending it is the member's explicit action through the existing message API.

const { extractJson } = require('../../lib/ai/jsonExtract');

const DRAFT_MARKER = '[[DRAFT]]';
const MAX_DRAFT_LENGTH = 800;

/**
 * The text the member may see so far, with any marker (or partial marker)
 * and everything after it removed.
 */
function visibleDuringStream(full) {
  const text = String(full || '');
  const index = text.indexOf(DRAFT_MARKER);
  if (index !== -1) return text.slice(0, index).trimEnd();

  // A trailing prefix of the marker is ambiguous: hold it back rather than
  // showing `[[DRA` for one frame.
  for (let k = DRAFT_MARKER.length - 1; k >= 1; k -= 1) {
    if (text.endsWith(DRAFT_MARKER.slice(0, k))) {
      return text.slice(0, -k).trimEnd();
    }
  }
  return text;
}

/** Split a complete answer into what the member reads and an optional draft. */
function extractDraft(full) {
  const text = String(full || '');
  const visible = visibleDuringStream(text);
  const index = text.indexOf(DRAFT_MARKER);
  if (index === -1) return { visible, draft: null };

  const parsed = extractJson(text.slice(index + DRAFT_MARKER.length));
  const value = parsed && typeof parsed.proposedMessage === 'string'
    ? parsed.proposedMessage.trim()
    : '';
  if (!value || value.length > MAX_DRAFT_LENGTH) return { visible, draft: null };

  return { visible, draft: value };
}

module.exports = { DRAFT_MARKER, visibleDuringStream, extractDraft };
