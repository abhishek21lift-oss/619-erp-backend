// src/middleware/validate.js
// Request validation using Zod schemas.
// Usage:
//   router.post('/clients', validate(clientSchemas.create), handler);
//   router.put('/clients/:id', validate(clientSchemas.update), handler);

const logger = require('../lib/logger');

function validate(schemas) {
  return function(req, res, next) {
    try {
      if (schemas.body)   req.body   = schemas.body.parse(req.body);
      if (schemas.query) {
        // express 5 parses req.query on every access and defines no setter, so
        // the assignment below would be dropped silently and handlers would
        // receive the raw strings the schema was meant to coerce.
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      const issues = err && err.issues ? err.issues : [];
      const fields = {};
      for (let i = 0; i < issues.length; i++) {
        const issue = issues[i];
        fields[issue.path.join('.')] = issue.message;
      }

      logger.warn({
        path: req.path,
        method: req.method,
        fields: fields,
      }, 'Validation failed');

      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'Invalid request',
          fields: fields,
        },
      });
    }
  };
}

module.exports = { validate };
