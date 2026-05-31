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

  logger.error({ err: err, method: req.method, url: req.originalUrl }, 'Unhandled error');
  const isDev = process.env.NODE_ENV !== 'production';
  res.status(500).json({
    error: isDev ? err.message : 'Something went wrong',
    ...(isDev && err.stack && { stack: err.stack.split('\n').slice(0, 4).join('\n') }),
  });
}

module.exports = { HttpError, notFound, errorHandler };
