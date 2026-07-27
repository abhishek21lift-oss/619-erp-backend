'use strict';
// Plain-text extraction for the AI knowledge base. Phase 1 supports the two
// formats SOPs/guides/policies actually show up in: PDF and plain text.
// DOCX/CSV/Excel ingestion is a deliberate fast-follow, not implemented here.

const logger = require('../logger');

const SUPPORTED_MIME_TYPES = ['application/pdf', 'text/plain'];

/**
 * Extracts plain text from a document buffer. Throws a descriptive error for
 * unsupported types rather than silently returning empty text — an ingested
 * "document" with no content would otherwise sit as a permanently-empty,
 * confusing entry in the knowledge base.
 */
async function extractText(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    // Lazy-required: pdf-parse pulls in a PDF.js-derived parser that's only
    // needed on this one path.
    const pdfParse = require('pdf-parse');
    try {
      const result = await pdfParse(buffer);
      return (result.text || '').trim();
    } catch (err) {
      logger.warn({ err: err.message }, 'ai_knowledge_pdf_parse_failed');
      throw new Error('Could not read this PDF — it may be scanned/image-only or corrupted.');
    }
  }

  if (mimeType === 'text/plain') {
    return buffer.toString('utf8').trim();
  }

  throw new Error(`Unsupported file type: ${mimeType}`);
}

module.exports = { extractText, SUPPORTED_MIME_TYPES };
