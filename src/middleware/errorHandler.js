// src/middleware/errorHandler.js
// Centralized error handler. Mount LAST.

const logger = require('../lib/logger');

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notFound(req, res) {
  res.status(404).json({ error: 'Not found: ' + req.method + ' ' + req.path });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.details && { details: err.details }),
    });
  }

  // ISSUE-050: structured responses for PostgreSQL constraint violations
  if (err.code === '23505') return res.status(409).json({ error: 'Duplicate entry — this record already exists.' });
  if (err.code === '23514') return res.status(400).json({ error: 'Value violates a data integrity constraint.' });
  if (err.code === '23503') return res.status(409).json({ error: 'Referenced record does not exist.' });
  if (err.code === '22001') return res.status(400).json({ error: 'Value too long for field.' });

  logger.error({ err: err.message, stack: err.stack, method: req.method, url: req.originalUrl }, 'Unhandled error');
  // M-01: never leak internal error details to clients in production
  const message = process.env.NODE_ENV === 'production'
    ? 'An internal error occurred'
    : (err.message || 'Internal server error');
  res.status(500).json({ error: message });
}

module.exports = { HttpError, notFound, errorHandler };
