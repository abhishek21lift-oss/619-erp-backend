'use strict';
// One fact, one owner. A write to a fact another module owns is refused with
// 422 FIELD_MOVED, naming the owner and the endpoint that does accept it, so a
// legacy caller cannot read a 200 and believe the value was saved.
//
// Only a supplied value counts. `null` means "clear/absent" here, which is how
// an old form clears a legacy value (Mobility's sit-and-reach) without being
// refused.

const logger = require('./logger');

/** The supplied fields in `ownership`, as { field, owner, endpoint }. */
function movedFields(body, ownership) {
  if (!body || typeof body !== 'object') return [];
  const out = [];
  for (const [field, rule] of Object.entries(ownership)) {
    if (body[field] != null) out.push({ field, owner: rule.owner, endpoint: rule.endpoint });
  }
  return out;
}

/**
 * Answer 422 and return true when the body writes a field owned elsewhere.
 * Call it before anything is written, so a refused request changes nothing.
 */
function rejectMovedFields(req, res, route, ownership) {
  const fields = movedFields(req.body, ownership);
  if (fields.length === 0) return false;
  logger.warn({
    event: 'ownership.field_moved',
    route,
    fields: fields.map((f) => f.field),
    user_id: req.user?.id ?? null,
    client_id: (req.body && req.body.client_id) ?? req.params?.id ?? null,
  }, 'A write to a field owned by another module was refused');
  const names = fields.map((f) => f.field).join(', ');
  res.status(422).json({
    error: {
      code: 'FIELD_MOVED',
      message: `${names} ${fields.length === 1 ? 'is' : 'are'} owned by another module. Save ${fields.length === 1 ? 'it' : 'them'} there instead.`,
      fields,
    },
  });
  return true;
}

module.exports = { movedFields, rejectMovedFields };
