// src/middleware/validate.js
// Lightweight request validation using Zod-like schemas.
// In a v3 monorepo this would import from packages/shared, but stays local here.

function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.body)   req.body   = schemas.body.parse(req.body);
      if (schemas.query)  req.query  = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      const issues = err?.issues || [];
      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'Invalid request',
          fields: Object.fromEntries(
            issues.map(i => [i.path.join('.'), i.message])
          ),
        },
      });
    }
  };
}

module.exports = { validate };
